package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type NativeProvider struct {
	productionAPNS *NativeProvider
	Client         *http.Client
	APNSKey        *ecdsa.PrivateKey
	APNSKeyID      string
	APNSTeamID     string
	FCMKey         *rsa.PrivateKey
	FCMEmail       string
	FCMProject     string
	apnsProduction string
	apnsSandbox    string
	fcmURL         string
	oauthURL       string
	mu             sync.Mutex
	apnsJWT        string
	apnsIssued     time.Time
	fcmToken       string
	fcmExpires     time.Time
	requireHTTP2   bool
}
type serviceAccount struct {
	Type        string `json:"type"`
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
}

func NewNativeProviderFromEnv() (*NativeProvider, error) {
	p := &NativeProvider{Client: &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, ResponseHeaderTimeout: 7 * time.Second, MaxIdleConns: 20, MaxIdleConnsPerHost: 10, IdleConnTimeout: 60 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, apnsProduction: "https://api.push.apple.com", apnsSandbox: "https://api.sandbox.push.apple.com", oauthURL: "https://oauth2.googleapis.com/token", requireHTTP2: true}
	if err := loadAPNSSigner(p, "APNS_"); err != nil {
		return nil, err
	}
	if os.Getenv("APNS_PRODUCTION_PRIVATE_KEY_FILE") != "" {
		production := &NativeProvider{Client: p.Client, apnsProduction: p.apnsProduction, requireHTTP2: p.requireHTTP2}
		if err := loadAPNSSigner(production, "APNS_PRODUCTION_"); err != nil {
			return nil, err
		}
		p.productionAPNS = production
	}
	if path := os.Getenv("FCM_SERVICE_ACCOUNT_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, errors.New("cannot read FCM service account")
		}
		var account serviceAccount
		if json.Unmarshal(raw, &account) != nil || account.Type != "service_account" || account.ProjectID == "" || account.ClientEmail == "" {
			return nil, errors.New("invalid FCM service account")
		}
		key, err := parseKey([]byte(account.PrivateKey))
		if err != nil {
			return nil, errors.New("invalid FCM signing key")
		}
		var ok bool
		p.FCMKey, ok = key.(*rsa.PrivateKey)
		if !ok || p.FCMKey.N.BitLen() < 2048 {
			return nil, errors.New("FCM requires RSA 2048 or stronger")
		}
		p.FCMEmail = account.ClientEmail
		p.FCMProject = account.ProjectID
		p.fcmURL = "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(account.ProjectID) + "/messages:send"
	}
	if p.APNSKey == nil && p.productionAPNS == nil && p.FCMKey == nil {
		return nil, errors.New("configure at least one provider")
	}
	return p, nil
}
func loadAPNSSigner(p *NativeProvider, prefix string) error {
	if path := os.Getenv(prefix + "PRIVATE_KEY_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return errors.New("cannot read APNs signing key")
		}
		key, err := parseKey(raw)
		if err != nil {
			return errors.New("invalid APNs signing key")
		}
		var ok bool
		p.APNSKey, ok = key.(*ecdsa.PrivateKey)
		if !ok || p.APNSKey.Curve != elliptic.P256() {
			return errors.New("APNs requires a P-256 key")
		}
		p.APNSKeyID, err = envRequired(prefix + "KEY_ID")
		if err != nil {
			return err
		}
		p.APNSTeamID, err = envRequired(prefix + "TEAM_ID")
		if err != nil {
			return err
		}
	}
	return nil
}
func parseKey(raw []byte) (any, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("invalid PEM")
	}
	return x509.ParsePKCS8PrivateKey(block.Bytes)
}
func jwtParts(header, claims any) (string, error) {
	h, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	c, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c), nil
}
func fixedInteger(value *big.Int) []byte { out := make([]byte, 32); value.FillBytes(out); return out }
func (p *NativeProvider) apnsAuthorization() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if p.apnsJWT != "" && now.Sub(p.apnsIssued) < 50*time.Minute {
		return p.apnsJWT, nil
	}
	body, err := jwtParts(map[string]string{"alg": "ES256", "kid": p.APNSKeyID}, map[string]any{"iss": p.APNSTeamID, "iat": now.Unix()})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(body))
	r, s, err := ecdsa.Sign(rand.Reader, p.APNSKey, digest[:])
	if err != nil {
		return "", err
	}
	signature := append(fixedInteger(r), fixedInteger(s)...)
	p.apnsJWT = body + "." + base64.RawURLEncoding.EncodeToString(signature)
	p.apnsIssued = now
	return p.apnsJWT, nil
}
func (p *NativeProvider) fcmAuthorization(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if p.fcmToken != "" && now.Before(p.fcmExpires.Add(-time.Minute)) {
		return p.fcmToken, nil
	}
	body, err := jwtParts(map[string]string{"alg": "RS256", "typ": "JWT"}, map[string]any{"iss": p.FCMEmail, "scope": "https://www.googleapis.com/auth/firebase.messaging", "aud": p.oauthURL, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(body))
	signature, err := rsa.SignPKCS1v15(rand.Reader, p.FCMKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	assertion := body + "." + base64.RawURLEncoding.EncodeToString(signature)
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, "POST", p.oauthURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := p.Client.Do(req)
	if err != nil {
		return "", errors.New("OAuth handoff unavailable")
	}
	defer res.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&token) != nil || token.AccessToken == "" || token.TokenType != "Bearer" || token.ExpiresIn <= 60 {
		return "", errors.New("OAuth authorization failed")
	}
	p.fcmToken = token.AccessToken
	p.fcmExpires = now.Add(time.Duration(token.ExpiresIn) * time.Second)
	return p.fcmToken, nil
}
func notificationData(n Notification) map[string]string {
	if n.RegistrationID != "" {
		return map[string]string{"kind": "registration_challenge", "registration_id": n.RegistrationID, "nonce": n.Nonce}
	}
	return map[string]string{"kind": "incident", "connection_id": n.ConnectionID, "event_id": n.EventID, "incident_id": n.IncidentID, "organization_id": n.OrganizationID, "title": n.Title, "resource": n.Resource, "severity": n.Severity}
}
func collapseID(n Notification) string {
	if n.RegistrationID != "" {
		return hash("registration:" + n.RegistrationID)
	}
	return hash(n.ConnectionID + "\x00" + n.OrganizationID + "\x00" + n.IncidentID)
}
func (p *NativeProvider) Send(ctx context.Context, d Destination, n Notification) ProviderResult {
	if d.Platform == "ios" {
		if d.Environment == "production" && p.productionAPNS != nil {
			return p.productionAPNS.sendAPNS(ctx, d, n)
		}
		if p.APNSKey == nil {
			return ProviderResult{Code: "provider_unconfigured"}
		}
		return p.sendAPNS(ctx, d, n)
	}
	if d.Platform == "android" {
		if p.FCMKey == nil {
			return ProviderResult{Code: "provider_unconfigured"}
		}
		return p.sendFCM(ctx, d, n)
	}
	return ProviderResult{Permanent: true, Code: "invalid_platform"}
}
func (p *NativeProvider) sendAPNS(ctx context.Context, d Destination, n Notification) ProviderResult {
	n = n.renderDisplayDeadline()
	token, err := p.apnsAuthorization()
	if err != nil {
		return ProviderResult{Code: "provider_authorization"}
	}
	ttl := n.remainingTTL()
	if ttl <= 0 {
		return ProviderResult{Permanent: true, Code: "expired"}
	}
	payload := map[string]any{"aps": map[string]any{"alert": map[string]string{"title": n.Title, "body": n.Resource}, "sound": "default", "thread-id": collapseID(n)}}
	payload["body"] = notificationData(n)
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > 4096 {
		return ProviderResult{Permanent: true, Code: "payload_size"}
	}
	endpoint := p.apnsProduction
	if d.Environment == "sandbox" {
		endpoint = p.apnsSandbox
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint+"/3/device/"+url.PathEscape(d.Token), bytes.NewReader(raw))
	if err != nil {
		return ProviderResult{Permanent: true, Code: "invalid_request"}
	}
	req.Header.Set("Authorization", "bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apns-topic", d.AppID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("apns-expiration", decimal(time.Now().Add(time.Duration(ttl)*time.Second).Unix()))
	req.Header.Set("apns-collapse-id", collapseID(n))
	res, err := p.Client.Do(req)
	if err != nil {
		return ProviderResult{Code: "handoff_unknown"}
	}
	defer res.Body.Close()
	if p.requireHTTP2 && res.ProtoMajor != 2 {
		return ProviderResult{Code: "http2_required"}
	}
	raw, _ = io.ReadAll(io.LimitReader(res.Body, 16384))
	if res.StatusCode == 200 {
		return ProviderResult{Accepted: true, Code: "accepted"}
	}
	var failure struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(raw, &failure)
	invalid := failure.Reason == "Unregistered" || failure.Reason == "BadDeviceToken" || failure.Reason == "DeviceTokenNotForTopic"
	permanent := invalid || res.StatusCode == 413 || (res.StatusCode == 400 && failure.Reason != "ExpiredProviderToken")
	return ProviderResult{Permanent: permanent, InvalidToken: invalid, Code: "provider_rejected"}
}
func (p *NativeProvider) sendFCM(ctx context.Context, d Destination, n Notification) ProviderResult {
	n = n.renderDisplayDeadline()
	token, err := p.fcmAuthorization(ctx)
	if err != nil {
		return ProviderResult{Code: "provider_authorization"}
	}
	ttl := n.remainingTTL()
	if ttl <= 0 {
		return ProviderResult{Permanent: true, Code: "expired"}
	}
	payload := map[string]any{"message": map[string]any{"token": d.Token, "notification": map[string]string{"title": n.Title, "body": n.Resource}, "data": notificationData(n), "android": map[string]any{"priority": "HIGH", "ttl": fmt.Sprintf("%ds", ttl), "restricted_package_name": d.AppID, "notification": map[string]string{"channel_id": "incidents", "tag": collapseID(n)}}}}
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > 4096 {
		return ProviderResult{Permanent: true, Code: "payload_size"}
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.fcmURL, bytes.NewReader(raw))
	if err != nil {
		return ProviderResult{Permanent: true, Code: "invalid_request"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return ProviderResult{Code: "handoff_unknown"}
	}
	defer res.Body.Close()
	raw, _ = io.ReadAll(io.LimitReader(res.Body, 16384))
	if res.StatusCode == 200 {
		return ProviderResult{Accepted: true, Code: "accepted"}
	}
	var failure struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				Type      string `json:"@type"`
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &failure)
	invalid := false
	for _, detail := range failure.Error.Details {
		if detail.Type == "type.googleapis.com/google.firebase.fcm.v1.FcmError" && detail.ErrorCode == "UNREGISTERED" {
			invalid = true
		}
	}
	permanent := invalid || res.StatusCode == 400 || res.StatusCode == 413
	return ProviderResult{Permanent: permanent, InvalidToken: invalid, Code: "provider_rejected"}
}

func (n Notification) remainingTTL() int {
	ttl := n.TTL
	if !n.Deadline.IsZero() {
		remaining := int(time.Until(n.Deadline) / time.Second)
		if remaining < ttl {
			ttl = remaining
		}
	}
	return ttl
}
