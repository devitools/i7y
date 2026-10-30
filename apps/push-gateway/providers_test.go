package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testECDSA(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}
func testRSA(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}
func jwtDecoded(t *testing.T, value string) (string, []byte, map[string]any, map[string]any) {
	t.Helper()
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		t.Fatal("invalid JWT shape")
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	claimsRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	var header, claims map[string]any
	if json.Unmarshal(headerRaw, &header) != nil || json.Unmarshal(claimsRaw, &claims) != nil {
		t.Fatal("invalid JWT JSON")
	}
	return parts[0] + "." + parts[1], signature, header, claims
}
func TestAPNSHTTP2RequestShapeJWTAndRejectionClassification(t *testing.T) {
	key := testECDSA(t)
	var status atomic.Int32
	status.Store(200)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 || r.Method != "POST" || r.URL.Path != "/3/device/"+strings.Repeat("a", 64) {
			t.Error("invalid APNs transport")
		}
		if r.Header.Get("apns-topic") != "com.example.i7y" || r.Header.Get("apns-push-type") != "alert" || r.Header.Get("apns-priority") != "10" || len(r.Header.Get("apns-collapse-id")) != 64 {
			t.Error("invalid APNs headers")
		}
		expires, err := strconv.ParseInt(r.Header.Get("apns-expiration"), 10, 64)
		if err != nil || expires > time.Now().Add(60*time.Second).Unix() || expires < time.Now().Unix() {
			t.Error("unbounded APNs expiration")
		}
		signed, signature, header, claims := jwtDecoded(t, strings.TrimPrefix(r.Header.Get("Authorization"), "bearer "))
		digest := sha256.Sum256([]byte(signed))
		if len(signature) != 64 || !ecdsa.Verify(&key.PublicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) || header["alg"] != "ES256" || header["kid"] != "key-id" || claims["iss"] != "team-id" {
			t.Error("invalid APNs JWT")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid APNs body")
		}
		aps, ok := body["aps"].(map[string]any)
		if !ok {
			t.Error("missing alert")
		} else if _, ok = aps["alert"].(map[string]any); !ok {
			t.Error("APNs must contain native alert")
		}
		data, ok := body["body"].(map[string]any)
		if !ok || data["connection_id"] != "connection-1" || data["incident_id"] != "incident-1" || data["kind"] != "incident" {
			t.Error("invalid navigation data")
		}
		w.WriteHeader(int(status.Load()))
		if status.Load() != 200 {
			_, _ = io.WriteString(w, `{"reason":"Unregistered"}`)
		}
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	p := &NativeProvider{Client: server.Client(), APNSKey: key, APNSKeyID: "key-id", APNSTeamID: "team-id", apnsSandbox: server.URL, apnsProduction: server.URL, requireHTTP2: true}
	n := notification()
	n.ConnectionID = "connection-1"
	d := Destination{Platform: "ios", Token: strings.Repeat("a", 64), Environment: "sandbox", AppID: "com.example.i7y"}
	if result := p.Send(context.Background(), d, n); !result.Accepted {
		t.Fatal(result)
	}
	status.Store(410)
	if result := p.Send(context.Background(), d, n); !result.Permanent || !result.InvalidToken {
		t.Fatal(result)
	}
}
func TestFCMOAuthJWTNativeNotificationShapeAndTokenCaching(t *testing.T) {
	key := testRSA(t)
	var oauthRequests atomic.Int32
	var sends atomic.Int32
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			oauthRequests.Add(1)
			if r.Method != "POST" || r.ParseForm() != nil || r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				t.Error("invalid OAuth request")
			}
			signed, signature, header, claims := jwtDecoded(t, r.Form.Get("assertion"))
			digest := sha256.Sum256([]byte(signed))
			if rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature) != nil || header["alg"] != "RS256" || claims["scope"] != "https://www.googleapis.com/auth/firebase.messaging" || claims["aud"] != serverURL+"/token" || claims["iss"] != "gateway@example.iam.gserviceaccount.com" {
				t.Error("invalid OAuth JWT")
			}
			_, _ = io.WriteString(w, `{"access_token":"test-oauth","token_type":"Bearer","expires_in":3600}`)
			return
		}
		sends.Add(1)
		if r.URL.Path != "/v1/projects/project-id/messages:send" || r.Header.Get("Authorization") != "Bearer test-oauth" {
			t.Error("invalid FCM endpoint or authorization")
		}
		var body struct {
			Message struct {
				Token        string            `json:"token"`
				Notification map[string]string `json:"notification"`
				Data         map[string]string `json:"data"`
				Android      struct {
					TTL               string            `json:"ttl"`
					Priority          string            `json:"priority"`
					RestrictedPackage string            `json:"restricted_package_name"`
					Notification      map[string]string `json:"notification"`
				} `json:"android"`
			} `json:"message"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid FCM payload")
		}
		m := body.Message
		if m.Token != "android-native-token" || m.Notification["title"] != "CPU threshold exceeded" || m.Data["connection_id"] != "connection-1" || m.Data["kind"] != "incident" || m.Android.TTL != "60s" || m.Android.Priority != "HIGH" || m.Android.RestrictedPackage != "com.example.i7y" || m.Android.Notification["channel_id"] != "incidents" || len(m.Android.Notification["tag"]) != 64 {
			t.Error("invalid FCM notification/data/channel/TTL")
		}
		_, _ = io.WriteString(w, `{"name":"projects/project-id/messages/accepted"}`)
	}))
	defer server.Close()
	serverURL = server.URL
	p := &NativeProvider{Client: server.Client(), FCMKey: key, FCMEmail: "gateway@example.iam.gserviceaccount.com", FCMProject: "project-id", oauthURL: server.URL + "/token", fcmURL: server.URL + "/v1/projects/project-id/messages:send"}
	n := notification()
	n.ConnectionID = "connection-1"
	d := Destination{Platform: "android", Token: "android-native-token", Environment: "production", AppID: "com.example.i7y"}
	for i := 0; i < 2; i++ {
		if result := p.Send(context.Background(), d, n); !result.Accepted {
			t.Fatal(result)
		}
	}
	if oauthRequests.Load() != 1 || sends.Load() != 2 {
		t.Fatal("OAuth access token was not cached")
	}
}
func TestProviderTransientPermanentAndAmbiguousFailures(t *testing.T) {
	for _, test := range []struct {
		name               string
		status             int
		body               string
		permanent, invalid bool
	}{{"unregistered", 404, `{"error":{"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`, true, true}, {"invalid_payload", 400, `{"error":{"status":"INVALID_ARGUMENT"}}`, true, false}, {"throttled", 429, `{}`, false, false}, {"unavailable", 503, `{}`, false, false}, {"permission_configuration", 403, `{}`, false, false}} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			p := &NativeProvider{Client: server.Client(), FCMKey: testRSA(t), fcmToken: "cached", fcmExpires: time.Now().Add(time.Hour), fcmURL: server.URL}
			result := p.Send(context.Background(), Destination{Platform: "android", Token: "native-token"}, notification())
			if result.Accepted || result.Permanent != test.permanent || result.InvalidToken != test.invalid {
				t.Fatal(result)
			}
		})
	}
	p := &NativeProvider{Client: &http.Client{Transport: failureTransport{}}, FCMKey: testRSA(t), fcmToken: "cached", fcmExpires: time.Now().Add(time.Hour), fcmURL: "https://example.invalid/send"}
	result := p.Send(context.Background(), Destination{Platform: "android", Token: "native-token"}, notification())
	if result.Permanent || result.Accepted || result.Code != "handoff_unknown" {
		t.Fatal("transport failure must preserve ambiguous delivery", result)
	}
}

type failureTransport struct{}

func (failureTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, context.DeadlineExceeded
}
func TestChallengePayloadAndIncidentReplacementScope(t *testing.T) {
	n := Notification{RegistrationID: "registration-1", Nonce: "secret-nonce"}
	data := notificationData(n)
	if len(data) != 3 || data["kind"] != "registration_challenge" || data["nonce"] != "secret-nonce" {
		t.Fatal("challenge leaked incident navigation")
	}
	a := notification()
	a.ConnectionID = "one"
	b := a
	b.EventID = "event-2"
	if collapseID(a) != collapseID(b) {
		t.Fatal("updates for same incident must replace display")
	}
	b.ConnectionID = "two"
	if collapseID(a) == collapseID(b) {
		t.Fatal("replacement scope crossed connection")
	}
	a.Deadline = time.Now().Add(-time.Second)
	if a.remainingTTL() > 0 {
		t.Fatal("expired notification extended")
	}
}

func TestAPNSRegistrationUsesExpoRemoteDataEnvelope(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		data, ok := payload["body"].(map[string]any)
		if !ok || data["kind"] != "registration_challenge" || data["registration_id"] != "registration-1" || data["nonce"] != "proof-1" {
			t.Error("missing Expo iOS registration proof data")
		}
		if _, exists := payload["nonce"]; exists {
			t.Error("proof data must be inside the Expo body envelope")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	p := &NativeProvider{Client: server.Client(), APNSKey: testECDSA(t), APNSKeyID: "key-id", APNSTeamID: "team-id", apnsSandbox: server.URL}
	result := p.Send(context.Background(), Destination{Platform: "ios", Token: strings.Repeat("a", 64), Environment: "sandbox", AppID: "com.example.i7y"}, Notification{Title: "Confirm", Resource: "Open app", RegistrationID: "registration-1", Nonce: "proof-1", TTL: 60, Deadline: time.Now().Add(time.Minute)})
	if !result.Accepted {
		t.Fatal(result)
	}
}

func TestAPNSEnvironmentUsesSeparateSigningKeys(t *testing.T) {
	keys := map[string]*ecdsa.PrivateKey{"sandbox": testECDSA(t), "production": testECDSA(t)}
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		signed, signature, header, _ := jwtDecoded(t, strings.TrimPrefix(r.Header.Get("Authorization"), "bearer "))
		key := keys[header["kid"].(string)]
		digest := sha256.Sum256([]byte(signed))
		if key == nil || !ecdsa.Verify(&key.PublicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
			t.Error("wrong environment signing key")
		}
		if header["kid"] != r.URL.Path[1:strings.LastIndex(r.URL.Path, "/3/device/")] {
			t.Error("signer crossed environment boundary")
		}
		calls.Add(1)
		w.WriteHeader(200)
	}))
	defer server.Close()
	production := &NativeProvider{Client: server.Client(), APNSKey: keys["production"], APNSKeyID: "production", APNSTeamID: "team", apnsProduction: server.URL + "/production"}
	p := &NativeProvider{Client: server.Client(), APNSKey: keys["sandbox"], APNSKeyID: "sandbox", APNSTeamID: "team", apnsSandbox: server.URL + "/sandbox", productionAPNS: production}
	for i := 0; i < 2; i++ {
		for _, env := range []string{"production", "sandbox"} {
			result := p.Send(context.Background(), Destination{Platform: "ios", Environment: env, AppID: "com.example.i7y", Token: strings.Repeat("a", 64)}, notification())
			if !result.Accepted {
				t.Fatal(result)
			}
		}
	}
	if calls.Load() != 4 {
		t.Fatal("missing sends")
	}
}
