package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func (f *fixture) startV2(t *testing.T, destination Destination, device, management string) (string, string) {
	t.Helper()
	body := map[string]string{"platform": destination.Platform, "app_id": destination.AppID, "environment": destination.Environment, "token": destination.Token}
	if device != "" {
		body["device_id"] = device
	}
	out := responseMap(t, request(t, f.g, "POST", "/v2/registrations", management, "", body), 201)
	return out["registration_id"], f.p.last().notification.Nonce
}

func (f *fixture) enrollV2(t *testing.T, token string) (string, string) {
	t.Helper()
	id, nonce := f.startV2(t, Destination{Platform: "ios", Token: token, Environment: "sandbox", AppID: "com.example.i7y"}, "", "")
	out := responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 200)
	return out["device_id"], out["management_token"]
}

func (f *fixture) bindV2(t *testing.T, device, management, connection, server string) (string, string) {
	t.Helper()
	out := responseMap(t, request(t, f.g, "POST", "/v2/bindings", management, "", map[string]string{"device_id": device, "connection_id": connection, "server_instance_id": server}), 201)
	return out["binding_id"], out["send_token"]
}

func genericNotification() GenericNotification {
	return GenericNotification{EventID: "event-1", Type: "task.ready", Title: "Task ready", Body: "A public summary", Data: map[string]string{"task_id": "task-1"}, TTL: 60}
}

func TestV2BindingsCoexistWithMigratedV1AndRevokeIndependently(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	legacy, legacySend := f.bind(t, device, management, "old")
	second, secondSend := f.bindV2(t, device, management, "second", "server-1")
	third, thirdSend := f.bindV2(t, device, management, "second", "server-2")
	for binding, send := range map[string]string{legacy: legacySend, second: secondSend, third: thirdSend} {
		responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "legacy-1", notification()), 202)
		if f.p.last().notification.Generic != nil || notificationData(f.p.last().notification)["kind"] != "incident" {
			t.Fatal("v1 provider payload changed")
		}
	}
	replacement, replacementSend := f.bindV2(t, device, management, "second", "server-1")
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+second+"/notifications", secondSend, "event-2", notification()), 401)
	responseMap(t, request(t, f.g, "DELETE", "/v2/bindings/"+legacy, management, "", nil), 204)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+legacy+"/notifications", legacySend, "event-2", notification()), 401)
	for binding, send := range map[string]string{replacement: replacementSend, third: thirdSend} {
		responseMap(t, request(t, f.g, "POST", "/v2/bindings/"+binding+"/notifications", send, "generic-1", genericNotification()), 202)
	}
}

func TestV2RotationPreservesBindingsAndRequiresBothProofAndAuthority(t *testing.T) {
	f := newFixture(t)
	device, management := f.enrollV2(t, strings.Repeat("a", 64))
	binding, send := f.bindV2(t, device, management, "first", "server-1")
	other, otherManagement := f.enrollV2(t, strings.Repeat("b", 64))
	otherBinding, otherSend := f.bindV2(t, other, otherManagement, "other", "server-2")
	id, nonce := f.startV2(t, Destination{Platform: "ios", Token: strings.Repeat("b", 64), Environment: "sandbox", AppID: "com.example.i7y"}, device, management)
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", management, "", map[string]string{"nonce": nonce}), 401)
	responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", otherManagement, "", map[string]string{"nonce": nonce}), 401)
	responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", management, "", map[string]string{"nonce": "wrong"}), 401)
	out := responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", management, "", map[string]string{"nonce": nonce}), 200)
	if out["device_id"] != device || out["management_token"] != management {
		t.Fatal("rotation changed stable authority")
	}
	responseMap(t, request(t, f.g, "POST", "/v2/bindings/"+binding+"/notifications", send, "rotated", genericNotification()), 202)
	if f.p.last().destination.Token != strings.Repeat("b", 64) {
		t.Fatal("binding did not follow token rotation")
	}
	responseMap(t, request(t, f.g, "POST", "/v2/bindings/"+otherBinding+"/notifications", otherSend, "stale", genericNotification()), 401)
	responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", management, "", map[string]string{"nonce": nonce}), 401)
	f.bindV2(t, device, management, "next", "server-3")
}

func TestV2ReinstallRevokesAllPreviousAuthorityAndPendingRotations(t *testing.T) {
	f := newFixture(t)
	device, management := f.enrollV2(t, strings.Repeat("a", 64))
	binding, send := f.bindV2(t, device, management, "first", "server-1")
	pending, nonce := f.startV2(t, Destination{Platform: "ios", Token: strings.Repeat("b", 64), Environment: "sandbox", AppID: "com.example.i7y"}, device, management)
	reinstalled, rotated := f.enrollV2(t, strings.Repeat("a", 64))
	if reinstalled != device || management == rotated {
		t.Fatal("reinstall must rotate prior authority")
	}
	responseMap(t, request(t, f.g, "POST", "/v2/bindings/"+binding+"/notifications", send, "old", genericNotification()), 401)
	responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+pending+"/confirm", management, "", map[string]string{"nonce": nonce}), 401)
	responseMap(t, request(t, f.g, "DELETE", "/v2/bindings/"+binding, management, "", nil), 401)
	f.bindV2(t, device, rotated, "new", "server-1")
}

func TestV2NamespaceIsolationAndEnrollmentBounds(t *testing.T) {
	f := newFixture(t)
	device, management := f.enrollV2(t, strings.Repeat("a", 64))
	f.cfg.Allowed["ios:com.example.other:sandbox"] = true
	body := map[string]string{"platform": "ios", "app_id": "com.example.other", "environment": "sandbox", "token": strings.Repeat("a", 64), "device_id": device}
	responseMap(t, request(t, f.g, "POST", "/v2/registrations", management, "", body), 401)
	delete(body, "device_id")
	responseMap(t, request(t, f.g, "POST", "/v2/registrations", management, "", body), 401)
	id, nonce := f.startV2(t, Destination{Platform: "ios", Token: strings.Repeat("a", 64), Environment: "sandbox", AppID: "com.example.other"}, "", "")
	out := responseMap(t, request(t, f.g, "POST", "/v2/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 200)
	if out["device_id"] == device {
		t.Fatal("cross-app device collision")
	}
	binding, _ := f.bindV2(t, out["device_id"], out["management_token"], "other", "server-1")
	responseMap(t, request(t, f.g, "DELETE", "/v2/bindings/"+binding, management, "", nil), 401)
	for i := 0; i < maxDeviceBindings; i++ {
		f.bindV2(t, device, management, fmt.Sprintf("connection-%d", i), "server-1")
	}
	responseMap(t, request(t, f.g, "POST", "/v2/bindings", management, "", map[string]string{"device_id": device, "connection_id": "overflow", "server_instance_id": "server-1"}), 429)
	f.bindV2(t, device, management, "connection-0", "server-1")
}

func TestV2GenericPayloadIdempotencyAndReservedContext(t *testing.T) {
	f := newFixture(t)
	device, management := f.enrollV2(t, strings.Repeat("a", 64))
	binding, send := f.bindV2(t, device, management, "connection-1", "server-1")
	path := "/v2/bindings/" + binding + "/notifications"
	before := f.p.count()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responseMap(t, request(t, f.g, "POST", path, send, "generic", genericNotification()), 202)
		}()
	}
	wg.Wait()
	if f.p.count() != before+1 {
		t.Fatal("generic retries duplicated provider handoff")
	}
	data := notificationData(f.p.last().notification)
	for key, expected := range map[string]string{"kind": "task.ready", "type": "task.ready", "app_id": "com.example.i7y", "platform": "ios", "environment": "sandbox", "connection_id": "connection-1", "server_instance_id": "server-1", "event_id": "event-1", "task_id": "task-1"} {
		if data[key] != expected {
			t.Fatalf("context %s=%s, want %s", key, data[key], expected)
		}
	}
	changed := genericNotification()
	changed.Data["task_id"] = "different"
	responseMap(t, request(t, f.g, "POST", path, send, "generic", changed), 409)
	for _, key := range []string{"connection_id", "server_instance_id", "app_id", "platform", "environment", "kind", "type", "event_id", "registration_id", "nonce", "from", "google.foo", "gcm.notification.foo"} {
		n := genericNotification()
		n.Data[key] = "forged"
		responseMap(t, request(t, f.g, "POST", path, send, "invalid", n), 400)
	}
	oversized := genericNotification()
	oversized.Data["large"] = strings.Repeat("x", 513)
	responseMap(t, request(t, f.g, "POST", path, send, "invalid", oversized), 400)
	f.p.set(ProviderResult{Code: "unavailable"})
	responseMap(t, request(t, f.g, "POST", path, send, "retry", genericNotification()), 503)
	f.now = f.now.Add(6 * time.Second)
	f.p.set(ProviderResult{Accepted: true})
	responseMap(t, request(t, f.g, "POST", path, send, "retry", genericNotification()), 202)
}

func TestProviderRegistryRoutesExactProfilesAndIsolatesCaches(t *testing.T) {
	dir := t.TempDir()
	writeKey := func(name string, key any) string {
		raw, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, name)
		if err = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	writeKey("first.p8", testECDSA(t))
	writeKey("second.p8", testECDSA(t))
	fcmKey := writeKey("firebase.pem", testRSA(t))
	privateKey, err := os.ReadFile(fcmKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, project := range []string{"first", "second"} {
		raw, _ := json.Marshal(map[string]string{"type": "service_account", "project_id": project, "client_email": project + "@example.iam.gserviceaccount.com", "private_key": string(privateKey)})
		if err = os.WriteFile(filepath.Join(dir, project+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	profiles := []AppProfile{
		{Platform: "ios", AppID: "com.first", Environment: "sandbox", APNS: &APNSConfig{PrivateKeyFile: "first.p8", KeyID: "FIRST", TeamID: "TEAM1"}},
		{Platform: "ios", AppID: "com.first", Environment: "production", APNS: &APNSConfig{PrivateKeyFile: "second.p8", KeyID: "SECOND", TeamID: "TEAM2"}},
		{Platform: "android", AppID: "com.first", Environment: "production", AndroidChannelID: "incidents", FCM: &FCMConfig{ServiceAccountFile: "first.json"}},
		{Platform: "android", AppID: "com.second", Environment: "production", AndroidChannelID: "tasks", FCM: &FCMConfig{ServiceAccountFile: "second.json"}},
	}
	config := filepath.Join(dir, "gateway.json")
	writeConfig := func(profiles []AppProfile) {
		raw, _ := json.Marshal(map[string]any{"profiles": profiles})
		if err = os.WriteFile(config, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig(profiles)
	registry, allowed, err := NewProviderRegistry(config)
	if err != nil || len(allowed) != 4 {
		t.Fatalf("registry: %v, %v", allowed, err)
	}
	first := registry.profiles["ios:com.first:sandbox"].(*NativeProvider)
	second := registry.profiles["ios:com.first:production"].(*NativeProvider)
	jwt1, _ := first.apnsAuthorization()
	jwt2, _ := second.apnsAuthorization()
	_, _, _, claims1 := jwtDecoded(t, jwt1)
	_, _, _, claims2 := jwtDecoded(t, jwt2)
	if claims1["iss"] != "TEAM1" || claims2["iss"] != "TEAM2" || jwt1 == jwt2 {
		t.Fatal("APNs credentials leaked across profiles")
	}
	for _, project := range []string{"first", "second"} {
		p := registry.profiles["android:com."+project+":production"].(*NativeProvider)
		if p.FCMProject != project || !strings.Contains(p.fcmURL, "/projects/"+project+"/") {
			t.Fatal("wrong Firebase project")
		}
	}
	fake1, fake2 := &fakeProvider{result: ProviderResult{Accepted: true}}, &fakeProvider{result: ProviderResult{Accepted: true}}
	registry.profiles["ios:com.first:sandbox"] = fake1
	registry.profiles["ios:com.first:production"] = fake2
	registry.Send(context.Background(), Destination{Platform: "ios", AppID: "com.first", Environment: "production"}, notification())
	if fake1.count() != 0 || fake2.count() != 1 {
		t.Fatal("wrong provider selected")
	}
	if registry.Send(context.Background(), Destination{Platform: "ios", AppID: "com.unknown", Environment: "production"}, notification()).Accepted {
		t.Fatal("unknown profile accepted")
	}
	writeConfig(append(profiles, profiles[0]))
	if _, _, err = NewProviderRegistry(config); err == nil {
		t.Fatal("duplicate profile accepted")
	}
	writeConfig(profiles)
	t.Setenv("GATEWAY_CONFIG_FILE", config)
	t.Setenv("GATEWAY_ALLOWED_APPS", "invalid")
	if _, allowed, err = NewConfiguredProviderFromEnv(); err != nil || len(allowed) != 4 {
		t.Fatalf("registry did not supersede legacy env: %v", err)
	}
}

func TestLegacyDatabaseUpgradePreservesIDsCapabilitiesAndReceipts(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "legacy")
	path := "/v1/bindings/" + binding + "/notifications"
	responseMap(t, request(t, f.g, "POST", path, send, "old-receipt", notification()), 202)
	id, nonce := f.start(t, strings.Repeat("b", 64))
	for _, column := range []string{"api_version", "device_id", "management_hash"} {
		if _, err := f.g.db.Exec(`ALTER TABLE registrations DROP COLUMN ` + column); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.g.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.g, err = NewGateway(f.cfg, f.p)
	if err != nil {
		t.Fatal(err)
	}
	before := f.p.count()
	responseMap(t, request(t, f.g, "POST", path, send, "old-receipt", notification()), 202)
	if before != f.p.count() {
		t.Fatal("upgrade lost durable v1 receipt")
	}
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 200)
	f.bindV2(t, device, management, "additional", "server-2")
	responseMap(t, request(t, f.g, "POST", path, send, "post-upgrade", notification()), 202)
}

func TestLegacyProviderEnvironmentRemainsSupported(t *testing.T) {
	dir := t.TempDir()
	raw, err := x509.MarshalPKCS8PrivateKey(testECDSA(t))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "signer.p8")
	if err = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GATEWAY_CONFIG_FILE", "")
	t.Setenv("GATEWAY_ALLOWED_APPS", "ios:com.legacy:sandbox,ios:com.legacy:production")
	t.Setenv("APNS_PRIVATE_KEY_FILE", path)
	t.Setenv("APNS_KEY_ID", "LEGACYKEY")
	t.Setenv("APNS_TEAM_ID", "LEGACYTEAM")
	t.Setenv("APNS_PRODUCTION_PRIVATE_KEY_FILE", path)
	t.Setenv("APNS_PRODUCTION_KEY_ID", "PRODKEY")
	t.Setenv("APNS_PRODUCTION_TEAM_ID", "PRODTEAM")
	t.Setenv("FCM_SERVICE_ACCOUNT_FILE", "")
	provider, allowed, err := NewConfiguredProviderFromEnv()
	if err != nil || len(allowed) != 2 {
		t.Fatalf("legacy configuration failed: %v", err)
	}
	native := provider.(*NativeProvider)
	if native.APNSTeamID != "LEGACYTEAM" || native.productionAPNS == nil || native.productionAPNS.APNSTeamID != "PRODTEAM" {
		t.Fatal("legacy signer selection changed")
	}
	t.Setenv("GATEWAY_ALLOWED_APPS", "android:com.legacy:production")
	if _, _, err = NewConfiguredProviderFromEnv(); err == nil {
		t.Fatal("unconfigured legacy provider accepted")
	}
}
