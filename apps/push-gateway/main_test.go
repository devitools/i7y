package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type sentMessage struct {
	destination  Destination
	notification Notification
}
type fakeProvider struct {
	mu       sync.Mutex
	messages []sentMessage
	result   ProviderResult
	entered  chan struct{}
	release  chan struct{}
}

func (p *fakeProvider) Send(ctx context.Context, d Destination, n Notification) ProviderResult {
	p.mu.Lock()
	p.messages = append(p.messages, sentMessage{d, n})
	result := p.result
	entered, release := p.entered, p.release
	p.mu.Unlock()
	if entered != nil && n.RegistrationID == "" {
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return ProviderResult{Code: "handoff_unknown"}
		}
	}
	return result
}
func (p *fakeProvider) count() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.messages) }
func (p *fakeProvider) last() sentMessage {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.messages[len(p.messages)-1]
}
func (p *fakeProvider) set(result ProviderResult) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.result = result
}

type fixture struct {
	g   *Gateway
	p   *fakeProvider
	now time.Time
	cfg Config
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{p: &fakeProvider{result: ProviderResult{Accepted: true}}, now: time.Now().Truncate(time.Second)}
	f.cfg = Config{DBPath: filepath.Join(t.TempDir(), "gateway.db"), Key: bytes.Repeat([]byte{42}, 32), Allowed: map[string]bool{"ios:com.example.i7y:sandbox": true, "android:com.example.i7y:production": true}, Now: func() time.Time { return f.now }}
	var err error
	f.g, err = NewGateway(f.cfg, f.p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.g.Close() })
	return f
}
func request(t *testing.T, g *Gateway, method, path, token, key string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	r.RemoteAddr = "192.0.2.1:1234"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	return w
}
func responseMap(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]string {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, expected %d: %s", w.Code, status, w.Body.String())
	}
	out := map[string]string{}
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}
func (f *fixture) start(t *testing.T, token string) (string, string) {
	t.Helper()
	w := request(t, f.g, "POST", "/v1/registrations", "", "", Destination{Platform: "ios", Token: token, Environment: "sandbox", AppID: "com.example.i7y"})
	out := responseMap(t, w, 201)
	message := f.p.last()
	if message.notification.RegistrationID != out["registration_id"] || message.notification.Nonce == "" {
		t.Fatal("missing proof fields")
	}
	return out["registration_id"], message.notification.Nonce
}
func (f *fixture) enroll(t *testing.T, token string) (string, string) {
	t.Helper()
	id, nonce := f.start(t, token)
	out := responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 200)
	return out["device_id"], out["management_token"]
}
func (f *fixture) bind(t *testing.T, device, management, connection string) (string, string) {
	t.Helper()
	out := responseMap(t, request(t, f.g, "POST", "/v1/bindings", management, "", map[string]string{"device_id": device, "connection_id": connection, "server_instance_id": "server-1"}), 201)
	return out["binding_id"], out["send_token"]
}
func notification() Notification {
	return Notification{EventID: "event-1", IncidentID: "incident-1", OrganizationID: "org-1", Title: "CPU threshold exceeded", Resource: "api-1", Severity: "critical", TTL: 60}
}
func TestRegistrationProofExpiryReplayAndRateLimit(t *testing.T) {
	f := newFixture(t)
	id, nonce := f.start(t, strings.Repeat("a", 64))
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": "wrong"}), 401)
	out := responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 200)
	if out["management_token"] == "" {
		t.Fatal("missing management capability")
	}
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 401)
	id, nonce = f.start(t, strings.Repeat("b", 64))
	f.now = f.now.Add(6 * time.Minute)
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 401)
	for i := 0; i < 3; i++ {
		f.start(t, strings.Repeat("c", 64))
	}
	responseMap(t, request(t, f.g, "POST", "/v1/registrations", "", "", Destination{Platform: "ios", Token: strings.Repeat("c", 64), Environment: "sandbox", AppID: "com.example.i7y"}), 429)
}
func TestRepeatedWrongProofCannotRecoverWithCorrectNonce(t *testing.T) {
	f := newFixture(t)
	id, nonce := f.start(t, strings.Repeat("a", 64))
	for i := 0; i < 5; i++ {
		responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": "wrong"}), 401)
	}
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+id+"/confirm", "", "", map[string]string{"nonce": nonce}), 401)
}
func TestCapabilitiesReinstallAndBindingReplacement(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-old")
	other, otherManagement := f.enroll(t, strings.Repeat("b", 64))
	otherBinding, otherSend := f.bind(t, other, otherManagement, "connection-other")
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", otherSend, "event-1", notification()), 401)
	responseMap(t, request(t, f.g, "DELETE", "/v1/bindings/"+otherBinding, management, "", nil), 401)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings", send, "", map[string]string{"device_id": device, "connection_id": "bad", "server_instance_id": "bad"}), 401)
	pendingID, pendingNonce := f.start(t, strings.Repeat("a", 64))
	newDevice, newManagement := f.enroll(t, strings.Repeat("a", 64))
	if newDevice != device || newManagement == management {
		t.Fatal("reinstall must retain unique destination and rotate authority")
	}
	responseMap(t, request(t, f.g, "POST", "/v1/registrations/"+pendingID+"/confirm", "", "", map[string]string{"nonce": pendingNonce}), 401)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 401)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings", management, "", map[string]string{"device_id": device, "connection_id": "old", "server_instance_id": "old"}), 401)
	newBinding, newSend := f.bind(t, device, newManagement, "connection-new")
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+newBinding+"/notifications", newSend, "event-1", notification()), 202)
	if f.p.last().notification.ConnectionID != "connection-new" {
		t.Fatal("gateway must inject bound connection")
	}
	replacement, _ := f.bind(t, device, newManagement, "connection-third")
	if replacement == newBinding {
		t.Fatal("new binding must be a new generation")
	}
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+newBinding+"/notifications", newSend, "event-2", notification()), 401)
}
func TestConcurrentIdempotencyAndPayloadCollision(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	before := f.p.count()
	var wg sync.WaitGroup
	codes := make(chan int, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()).Code
		}()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 202 {
			t.Fatal(code)
		}
	}
	if f.p.count() != before+1 {
		t.Fatal("concurrent duplicate provider handoff")
	}
	changed := notification()
	changed.Title = "Different title"
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", changed), 409)
}
func TestRevocationSerializesWithHandoffAndRejectsOfflineSender(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	f.p.entered = make(chan struct{}, 1)
	f.p.release = make(chan struct{})
	sent := make(chan int, 1)
	go func() {
		sent <- request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()).Code
	}()
	<-f.p.entered
	revoked := make(chan int, 1)
	go func() { revoked <- request(t, f.g, "DELETE", "/v1/bindings/"+binding, management, "", nil).Code }()
	select {
	case <-revoked:
		t.Fatal("revocation committed before the serialized handoff finished")
	case <-time.After(20 * time.Millisecond):
	}
	close(f.p.release)
	if <-sent != 202 || <-revoked != 204 {
		t.Fatal("handoff/revocation failed")
	}
	before := f.p.count()
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-2", notification()), 401)
	if f.p.count() != before {
		t.Fatal("revoked sender reached provider")
	}
}
func TestTransientRetryDurabilityAndInvalidTokenRevocation(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	f.p.set(ProviderResult{})
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 503)
	before := f.p.count()
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 503)
	if f.p.count() != before {
		t.Fatal("retry lease bypassed")
	}
	if err := f.g.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.g, err = NewGateway(f.cfg, f.p)
	if err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(6 * time.Second)
	f.p.set(ProviderResult{Accepted: true})
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 202)
	if f.p.last().notification.TTL != 60 || !f.p.last().notification.Deadline.Equal(f.now.Add(60*time.Second)) {
		t.Fatal("retry must preserve bounded provider TTL independently of its receipt window")
	}
	f.p.set(ProviderResult{Permanent: true, InvalidToken: true})
	out := responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-2", notification()), 422)
	if out["code"] != "invalid_token" {
		t.Fatal(out)
	}
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-3", notification()), 401)
}
func TestPendingCrashLeaseAndExpiry(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	f.p.set(ProviderResult{})
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 503)
	_, err := f.g.db.Exec(`UPDATE receipts SET state='pending',lease_until=?`, f.now.Unix()+15)
	if err != nil {
		t.Fatal(err)
	}
	before := f.p.count()
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 503)
	f.now = f.now.Add(301 * time.Second)
	out := responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 422)
	if out["code"] != "expired_or_exhausted" || f.p.count() != before {
		t.Fatal("expired receipt was handed off")
	}
}
func TestInvalidPayloadAllowlistAndRequestBounds(t *testing.T) {
	f := newFixture(t)
	responseMap(t, request(t, f.g, "POST", "/v1/registrations", "", "", Destination{Platform: "ios", Token: strings.Repeat("a", 64), Environment: "production", AppID: "com.example.i7y"}), 400)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	for _, change := range []func(*Notification){func(n *Notification) { n.TTL = 61 }, func(n *Notification) { n.Title = "bad\nbody" }, func(n *Notification) { n.Title = strings.Repeat("x", 121) }, func(n *Notification) { n.IncidentID = "https://evil.example" }, func(n *Notification) { n.Severity = "unknown" }} {
		n := notification()
		change(&n)
		responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", n), 400)
	}
	body := map[string]any{"event_id": "event-1", "incident_id": "incident-1", "organization_id": "org-1", "title": "title", "resource": "resource", "severity": "high", "ttl": 60, "token": "arbitrary-destination"}
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", body), 400)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", map[string]string{"title": strings.Repeat("x", 5000)}), 400)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "bad key", notification()), 400)
}
func TestStoreEncryptsNativeTokenAndHashesCapabilities(t *testing.T) {
	f := newFixture(t)
	native := strings.Repeat("a", 64)
	device, management := f.enroll(t, native)
	_, send := f.bind(t, device, management, "connection-1")
	var ciphertext []byte
	var stored string
	if err := f.g.db.QueryRow(`SELECT token_cipher,management_hash FROM devices WHERE id=?`, device).Scan(&ciphertext, &stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(native)) || stored == management {
		t.Fatal("plaintext secret persisted")
	}
	if _, err := gcmTamper(f.g, ciphertext); err == nil {
		t.Fatal("ciphertext accepted wrong destination AAD")
	}
	_, _ = f.g.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	for _, suffix := range []string{"", "-wal"} {
		data, err := os.ReadFile(f.cfg.DBPath + suffix)
		if err == nil && (bytes.Contains(data, []byte(native)) || bytes.Contains(data, []byte(management)) || bytes.Contains(data, []byte(send))) {
			t.Fatal("raw secret found in SQLite storage")
		}
	}
	info, err := os.Stat(f.cfg.DBPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("store must be private")
	}
	if another, err := NewGateway(f.cfg, f.p); err == nil {
		another.Close()
		t.Fatal("multiple process ownership allowed")
	}
}
func gcmTamper(g *Gateway, ciphertext []byte) (string, error) {
	return g.decrypt(ciphertext, "wrong-destination")
}
func TestReceiptRetentionDropsOnlyExpiredHashes(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 202)
	f.now = f.now.Add(8 * 24 * time.Hour)
	f.g.mu.Lock()
	err := f.g.cleanup()
	f.g.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.g.db.QueryRow(`SELECT count(*) FROM receipts`).Scan(&count); err != nil || count != 0 {
		t.Fatal("receipt retention failed")
	}
}
func TestPublicHealth(t *testing.T) {
	f := newFixture(t)
	w := request(t, f.g, "GET", "/healthz", "", "", nil)
	responseMap(t, w, 200)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing private response cache policy")
	}
}

func TestTrustedProxyClientIPCannotBeSpoofed(t *testing.T) {
	f := newFixture(t)
	r := httptest.NewRequest("GET", "/healthz", nil)
	r.RemoteAddr = "192.0.2.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.10")
	if f.g.clientIP(r) != "192.0.2.1" {
		t.Fatal("untrusted peer spoofed rate-limit identity")
	}
	_, network, _ := net.ParseCIDR("192.0.2.0/24")
	f.g.cfg.TrustedProxies = []*net.IPNet{network}
	r.Header.Set("X-Forwarded-For", "198.51.100.1, 203.0.113.10, 192.0.2.2")
	if f.g.clientIP(r) != "203.0.113.10" {
		t.Fatal("proxy chain did not select nearest untrusted client")
	}
	r.Header.Set("X-Forwarded-For", "malformed")
	if f.g.clientIP(r) != "192.0.2.1" {
		t.Fatal("invalid forwarding header trusted")
	}
}
func TestWrongEncryptionKeyFailsAtStartup(t *testing.T) {
	f := newFixture(t)
	if err := f.g.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := f.cfg
	cfg.Key = bytes.Repeat([]byte{9}, 32)
	if wrong, err := NewGateway(cfg, f.p); err == nil {
		wrong.Close()
		t.Fatal("wrong encryption key accepted")
	}
	var err error
	f.g, err = NewGateway(f.cfg, f.p)
	if err != nil {
		t.Fatal(err)
	}
}

func TestReceiptRetryWindowIsIndependentOfProviderTTL(t *testing.T) {
	f := newFixture(t)
	device, management := f.enroll(t, strings.Repeat("a", 64))
	binding, send := f.bind(t, device, management, "connection-1")
	f.p.set(ProviderResult{})
	started := f.now
	first, second := notification(), notification()
	second.EventID = "event-2"
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", first), 503)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-2", second), 503)
	if actual := f.p.last().notification; actual.TTL != 60 || !actual.Deadline.Equal(started.Add(60*time.Second)) {
		t.Fatal("initial provider expiration exceeded requested TTL")
	}
	f.now = started.Add(61 * time.Second)
	f.p.set(ProviderResult{Accepted: true})
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", first), 202)
	if actual := f.p.last().notification; actual.TTL != 60 || !actual.Deadline.Equal(f.now.Add(60*time.Second)) {
		t.Fatal("minute-later retry must receive its own bounded provider expiration")
	}
	var retryUntil int64
	if err := f.g.db.QueryRow(`SELECT expires FROM receipts WHERE binding_id=? AND key_hash=?`, binding, hash("event-1")).Scan(&retryUntil); err != nil {
		t.Fatal(err)
	}
	if retryUntil != started.Add(300*time.Second).Unix() {
		t.Fatal("retry extended the receipt window")
	}
	before := f.p.count()
	f.now = started.Add(301 * time.Second)
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", first), 202)
	out := responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-2", second), 422)
	if out["code"] != "expired_or_exhausted" || f.p.count() != before {
		t.Fatal("accepted or expired receipts triggered another provider handoff")
	}
}

func TestAPNSTokensSupportVariableLengthAndRejectMalformedInput(t *testing.T) {
	f := newFixture(t)
	simulatorToken := strings.Repeat("abcdef0123", 20)
	device, management := f.enroll(t, simulatorToken)
	binding, send := f.bind(t, device, management, "connection-simulator")
	responseMap(t, request(t, f.g, "POST", "/v1/bindings/"+binding+"/notifications", send, "event-1", notification()), 202)
	if f.p.last().destination.Token != simulatorToken {
		t.Fatal("simulator token was truncated or changed")
	}
	before := f.p.count()
	for _, token := range []string{"", "abc", strings.Repeat("z", 200), strings.Repeat("a", maxAPNSTokenHexLength+2)} {
		responseMap(t, request(t, f.g, "POST", "/v1/registrations", "", "", Destination{Platform: "ios", Token: token, Environment: "sandbox", AppID: "com.example.i7y"}), 400)
	}
	if f.p.count() != before {
		t.Fatal("malformed token reached provider")
	}
}
