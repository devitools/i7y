package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

type Destination struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	Environment string `json:"environment"`
	AppID       string `json:"app_id"`
}
type Notification struct {
	EventID        string    `json:"event_id"`
	IncidentID     string    `json:"incident_id"`
	OrganizationID string    `json:"organization_id"`
	Title          string    `json:"title"`
	Resource       string    `json:"resource"`
	DeadlineAt     string    `json:"deadline_at,omitempty"`
	Locale         string    `json:"locale,omitempty"`
	TimeZone       string    `json:"time_zone,omitempty"`
	Severity       string    `json:"severity"`
	TTL            int       `json:"ttl"`
	ConnectionID   string    `json:"-"`
	RegistrationID string    `json:"-"`
	Nonce          string    `json:"-"`
	Deadline       time.Time `json:"-"`
}
type ProviderResult struct {
	Accepted     bool
	Permanent    bool
	InvalidToken bool
	Code         string
}
type Provider interface {
	Send(context.Context, Destination, Notification) ProviderResult
}
type Config struct {
	TrustedProxies []*net.IPNet
	DBPath         string
	Key            []byte
	Allowed        map[string]bool
	ProofTTL       time.Duration
	Now            func() time.Time
}
type Gateway struct {
	db        *sql.DB
	aead      cipher.AEAD
	provider  Provider
	cfg       Config
	mu        sync.Mutex
	lockFile  *os.File
	admission chan struct{}
}
type apiError struct {
	status int
	code   string
}

func (e apiError) Error() string { return e.code }

const receiptRetryWindow = 300 * time.Second
const maxAPNSTokenHexLength = 1024

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var apnsToken = regexp.MustCompile(`^[a-fA-F0-9]+$`)

func main() {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("GATEWAY_ENCRYPTION_KEY"))
	if err != nil || len(key) != 32 {
		log.Fatal("GATEWAY_ENCRYPTION_KEY must be a base64 32-byte key")
	}
	allowed := map[string]bool{}
	for _, value := range strings.Split(os.Getenv("GATEWAY_ALLOWED_APPS"), ",") {
		if strings.TrimSpace(value) != "" {
			allowed[strings.TrimSpace(value)] = true
		}
	}
	if len(allowed) == 0 {
		log.Fatal("GATEWAY_ALLOWED_APPS is required")
	}
	provider, err := NewNativeProviderFromEnv()
	if err != nil {
		log.Fatal("invalid provider configuration: ", err)
	}
	for app := range allowed {
		parts := strings.Split(app, ":")
		if len(parts) != 3 || (parts[0] != "ios" && parts[0] != "android") || (parts[2] != "sandbox" && parts[2] != "production") || parts[1] == "" {
			log.Fatal("invalid app allowlist")
		}
		if parts[0] == "ios" && provider.APNSKey == nil && (parts[2] != "production" || provider.productionAPNS == nil) || parts[0] == "android" && provider.FCMKey == nil {
			log.Fatal("allowlisted platform has no provider credentials")
		}
	}
	path := os.Getenv("GATEWAY_DB_PATH")
	if path == "" {
		path = "/data/gateway.db"
	}
	var trustedProxies []*net.IPNet
	for _, value := range strings.Split(os.Getenv("GATEWAY_TRUSTED_PROXY_CIDRS"), ",") {
		if strings.TrimSpace(value) == "" {
			continue
		}
		_, network, err := net.ParseCIDR(strings.TrimSpace(value))
		if err != nil {
			log.Fatal("invalid trusted proxy CIDR")
		}
		trustedProxies = append(trustedProxies, network)
	}
	gateway, err := NewGateway(Config{DBPath: path, Key: key, Allowed: allowed, TrustedProxies: trustedProxies}, provider)
	if err != nil {
		log.Fatal("cannot open gateway store")
	}
	defer gateway.Close()
	addr := os.Getenv("GATEWAY_LISTEN")
	if addr == "" {
		addr = ":8080"
	}
	server := &http.Server{Addr: addr, Handler: gateway, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go gateway.CleanupLoop(ctx)
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		close(shutdownDone)
	}()
	log.Print("push gateway listening")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("HTTP server failed")
	}
	<-shutdownDone
}

func NewGateway(cfg Config, provider Provider) (*Gateway, error) {
	if len(cfg.Key) != 32 || len(cfg.Allowed) == 0 || provider == nil {
		return nil, errors.New("invalid gateway configuration")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.ProofTTL == 0 {
		cfg.ProofTTL = 5 * time.Minute
	}
	block, err := aes.NewCipher(cfg.Key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	lockFile, err := os.OpenFile(cfg.DBPath+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lockFile.Close()
		return nil, errors.New("database already owned by a gateway process")
	}
	success := false
	defer func() {
		if !success {
			lockFile.Close()
		}
	}()
	dataFile, err := os.OpenFile(cfg.DBPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = dataFile.Chmod(0600); err != nil {
		dataFile.Close()
		return nil, err
	}
	dataFile.Close()
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,destination_hash TEXT UNIQUE NOT NULL,platform TEXT NOT NULL,app_id TEXT NOT NULL,environment TEXT NOT NULL,token_cipher BLOB NOT NULL,management_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,destination_hash TEXT NOT NULL,platform TEXT NOT NULL,app_id TEXT NOT NULL,environment TEXT NOT NULL,token_cipher BLOB NOT NULL,nonce_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),connection_id TEXT NOT NULL,server_instance_id TEXT NOT NULL,send_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS bindings_device ON bindings(device_id);
 CREATE TABLE IF NOT EXISTS receipts(binding_id TEXT NOT NULL,key_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL,lease_until INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(binding_id,key_hash));
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS rates(key_hash TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(key_hash,bucket));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	var keyProof []byte
	err = db.QueryRow(`SELECT value FROM metadata WHERE key='encryption_check'`).Scan(&keyProof)
	if err == sql.ErrNoRows {
		nonce := make([]byte, aead.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			db.Close()
			return nil, err
		}
		keyProof = aead.Seal(nonce, nonce, []byte("i7y-push-gateway"), nil)
		_, err = db.Exec(`INSERT INTO metadata(key,value) VALUES('encryption_check',?)`, keyProof)
	} else if err == nil {
		if len(keyProof) < aead.NonceSize() {
			err = errors.New("invalid key check")
		} else {
			_, err = aead.Open(nil, keyProof[:aead.NonceSize()], keyProof[aead.NonceSize():], nil)
		}
	}
	if err != nil {
		db.Close()
		return nil, errors.New("cannot validate store encryption key")
	}
	success = true
	return &Gateway{db: db, aead: aead, provider: provider, cfg: cfg, lockFile: lockFile, admission: make(chan struct{}, 32)}, nil
}
func (g *Gateway) Close() error { err := g.db.Close(); _ = g.lockFile.Close(); return err }
func hash(value string) string {
	valueHash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(valueHash[:])
}
func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (g *Gateway) encrypt(token, destinationHash string) []byte {
	nonce := make([]byte, g.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic("random source unavailable")
	}
	return g.aead.Seal(nonce, nonce, []byte(token), []byte(destinationHash))
}
func (g *Gateway) decrypt(ciphertext []byte, destinationHash string) (string, error) {
	if len(ciphertext) < g.aead.NonceSize() {
		return "", errors.New("invalid ciphertext")
	}
	p, err := g.aead.Open(nil, ciphertext[:g.aead.NonceSize()], ciphertext[g.aead.NonceSize():], []byte(destinationHash))
	return string(p), err
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func decode(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return apiError{400, "invalid_request"}
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return apiError{400, "invalid_request"}
	}
	return nil
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	select {
	case g.admission <- struct{}{}:
		defer func() { <-g.admission }()
	default:
		jsonResponse(w, 503, map[string]string{"error": "gateway_busy"})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/healthz" {
		if err := g.db.PingContext(r.Context()); err != nil {
			jsonResponse(w, 503, map[string]string{"status": "unavailable"})
		} else {
			jsonResponse(w, 200, map[string]string{"status": "ok"})
		}
		return
	}
	var err error
	switch {
	case r.Method == "POST" && r.URL.Path == "/v1/registrations":
		err = g.register(w, r)
	case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/registrations/") && strings.HasSuffix(r.URL.Path, "/confirm"):
		err = g.confirm(w, r, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/registrations/"), "/confirm"))
	case r.Method == "POST" && r.URL.Path == "/v1/bindings":
		err = g.bind(w, r)
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v1/bindings/"):
		err = g.revoke(w, r, strings.TrimPrefix(r.URL.Path, "/v1/bindings/"))
	case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/bindings/") && strings.HasSuffix(r.URL.Path, "/notifications"):
		err = g.notify(w, r, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/bindings/"), "/notifications"))
	default:
		err = apiError{404, "not_found"}
	}
	if err != nil {
		var ae apiError
		if errors.As(err, &ae) {
			jsonResponse(w, ae.status, map[string]string{"error": ae.code})
		} else {
			jsonResponse(w, 500, map[string]string{"error": "internal_error"})
		}
	}
}
func (g *Gateway) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !g.trustedProxy(net.ParseIP(host)) {
		return host
	}
	forwarded := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate := strings.TrimSpace(forwarded[index])
		parsed := net.ParseIP(candidate)
		if parsed == nil {
			return host
		}
		if !g.trustedProxy(parsed) {
			return parsed.String()
		}
	}
	return host
}
func (g *Gateway) trustedProxy(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, network := range g.cfg.TrustedProxies {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
func (g *Gateway) rate(key string, limit int) error {
	bucket := g.cfg.Now().Unix() / 600
	key = hash(key)
	_, err := g.db.Exec(`INSERT INTO rates(key_hash,bucket,count) VALUES(?,?,1) ON CONFLICT(key_hash,bucket) DO UPDATE SET count=count+1`, key, bucket)
	if err != nil {
		return err
	}
	var count int
	if err = g.db.QueryRow(`SELECT count FROM rates WHERE key_hash=? AND bucket=?`, key, bucket).Scan(&count); err != nil {
		return err
	}
	if count > limit {
		return apiError{429, "rate_limited"}
	}
	return nil
}
func cleanString(s string, max int) bool {
	if s == "" || len(s) > max || !utf8.ValidString(s) || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}
func (g *Gateway) register(w http.ResponseWriter, r *http.Request) error {
	var d Destination
	if err := decode(w, r, &d); err != nil {
		return err
	}
	if d.Platform == "ios" {
		d.Token = strings.ToLower(d.Token)
	}
	if (d.Platform != "ios" && d.Platform != "android") || (d.Environment != "sandbox" && d.Environment != "production") || !g.cfg.Allowed[d.Platform+":"+d.AppID+":"+d.Environment] || !cleanString(d.Token, 4096) || (d.Platform == "ios" && (!apnsToken.MatchString(d.Token) || len(d.Token)%2 != 0 || len(d.Token) > maxAPNSTokenHexLength)) || (d.Platform == "android" && len(d.Token) < 20) {
		return apiError{400, "invalid_registration"}
	}
	dh := hash(d.Platform + "\x00" + d.AppID + "\x00" + d.Environment + "\x00" + d.Token)
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Context().Err() != nil {
		return apiError{503, "request_expired"}
	}
	if err := g.cleanup(); err != nil {
		return err
	}
	if err := g.rate("start:ip:"+g.clientIP(r), 10); err != nil {
		return err
	}
	if err := g.rate("start:token:"+dh, 3); err != nil {
		return err
	}
	id, nonce := randomToken(), randomToken()
	expires := g.cfg.Now().Add(g.cfg.ProofTTL).Unix()
	_, err := g.db.Exec(`INSERT INTO registrations(id,destination_hash,platform,app_id,environment,token_cipher,nonce_hash,expires) VALUES(?,?,?,?,?,?,?,?)`, id, dh, d.Platform, d.AppID, d.Environment, g.encrypt(d.Token, dh), hash(nonce), expires)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	result := g.provider.Send(ctx, d, Notification{Title: "Confirm notification setup", Resource: "Open the app to complete setup.", TTL: 60, RegistrationID: id, Nonce: nonce, Deadline: g.cfg.Now().Add(60 * time.Second)})
	if !result.Accepted {
		_, _ = g.db.Exec(`DELETE FROM registrations WHERE id=?`, id)
		if result.Permanent {
			return apiError{422, "registration_delivery_failed"}
		}
		w.Header().Set("Retry-After", "5")
		return apiError{503, "registration_delivery_unavailable"}
	}
	_, err = g.db.Exec(`UPDATE registrations SET ready=1 WHERE id=?`, id)
	if err != nil {
		return err
	}
	jsonResponse(w, 201, map[string]any{"registration_id": id, "expires_at": time.Unix(expires, 0).UTC().Format(time.RFC3339)})
	return nil
}
func bearer(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") || len(value) != 50 {
		return ""
	}
	return strings.TrimPrefix(value, "Bearer ")
}
func capMatches(token, stored string) bool {
	got := hash(token)
	return token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(stored)) == 1
}
func denied() error { return apiError{401, "unauthorized"} }
func (g *Gateway) confirm(w http.ResponseWriter, r *http.Request, id string) error {
	var body struct {
		Nonce string `json:"nonce"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Context().Err() != nil {
		return apiError{503, "request_expired"}
	}
	if err := g.rate("proof:ip:"+g.clientIP(r), 30); err != nil {
		return err
	}
	if err := g.rate("proof:registration:"+id, 8); err != nil {
		return err
	}
	var dh, platform, app, environment, nonceHash string
	var cipherToken []byte
	var expires int64
	var attempts, ready int
	err := g.db.QueryRow(`SELECT destination_hash,platform,app_id,environment,token_cipher,nonce_hash,expires,attempts,ready FROM registrations WHERE id=?`, id).Scan(&dh, &platform, &app, &environment, &cipherToken, &nonceHash, &expires, &attempts, &ready)
	if err == sql.ErrNoRows {
		return denied()
	}
	if err != nil {
		return err
	}
	_, err = g.db.Exec(`UPDATE registrations SET attempts=attempts+1 WHERE id=?`, id)
	if err != nil {
		return err
	}
	if expires <= g.cfg.Now().Unix() || attempts >= 5 || ready != 1 || !capMatches(body.Nonce, nonceHash) {
		return denied()
	}
	management := randomToken()
	deviceID := randomToken()
	tx, err := g.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	err = tx.QueryRow(`SELECT id FROM devices WHERE destination_hash=?`, dh).Scan(&deviceID)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	_, err = tx.Exec(`INSERT INTO devices(id,destination_hash,platform,app_id,environment,token_cipher,management_hash,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(destination_hash) DO UPDATE SET token_cipher=excluded.token_cipher,management_hash=excluded.management_hash,active=1`, deviceID, dh, platform, app, environment, cipherToken, hash(management))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE bindings SET active=0 WHERE device_id=?`, deviceID); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM registrations WHERE destination_hash=?`, dh); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	jsonResponse(w, 200, map[string]string{"device_id": deviceID, "management_token": management})
	return nil
}
func (g *Gateway) authorizeDevice(r *http.Request, id string) error {
	var stored string
	err := g.db.QueryRow(`SELECT management_hash FROM devices WHERE id=? AND active=1`, id).Scan(&stored)
	if err == sql.ErrNoRows {
		return denied()
	}
	if err != nil {
		return err
	}
	if !capMatches(bearer(r), stored) {
		return denied()
	}
	return nil
}
func (g *Gateway) bind(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		DeviceID         string `json:"device_id"`
		ConnectionID     string `json:"connection_id"`
		ServerInstanceID string `json:"server_instance_id"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !identifier.MatchString(body.ConnectionID) || !identifier.MatchString(body.ServerInstanceID) {
		return apiError{400, "invalid_binding"}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Context().Err() != nil {
		return apiError{503, "request_expired"}
	}
	if err := g.authorizeDevice(r, body.DeviceID); err != nil {
		return err
	}
	id, send := randomToken(), randomToken()
	tx, err := g.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE bindings SET active=0 WHERE device_id=?`, body.DeviceID); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO bindings(id,device_id,connection_id,server_instance_id,send_hash) VALUES(?,?,?,?,?)`, id, body.DeviceID, body.ConnectionID, body.ServerInstanceID, hash(send)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	jsonResponse(w, 201, map[string]string{"binding_id": id, "send_token": send})
	return nil
}
func (g *Gateway) revoke(w http.ResponseWriter, r *http.Request, id string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Context().Err() != nil {
		return apiError{503, "request_expired"}
	}
	var device string
	err := g.db.QueryRow(`SELECT device_id FROM bindings WHERE id=?`, id).Scan(&device)
	if err == sql.ErrNoRows {
		return denied()
	}
	if err != nil {
		return err
	}
	if err = g.authorizeDevice(r, device); err != nil {
		return err
	}
	if _, err = g.db.Exec(`UPDATE bindings SET active=0 WHERE id=?`, id); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (n *Notification) validate() bool {
	return identifier.MatchString(n.EventID) && identifier.MatchString(n.IncidentID) && identifier.MatchString(n.OrganizationID) && cleanString(n.Title, 120) && cleanString(n.Resource, 512) && n.validDisplayDeadline() && (n.Severity == "critical" || n.Severity == "high" || n.Severity == "medium" || n.Severity == "low" || n.Severity == "info" || n.Severity == "warning" || n.Severity == "error") && n.TTL > 0 && n.TTL <= 60
}
func receiptResponse(w http.ResponseWriter, state, code string) {
	status := 503
	if state == "accepted" {
		status = 202
	} else if state == "permanent_failure" {
		status = 422
	} else {
		w.Header().Set("Retry-After", "5")
	}
	jsonResponse(w, status, map[string]string{"status": state, "code": code})
}
func (g *Gateway) notify(w http.ResponseWriter, r *http.Request, id string) error {
	var n Notification
	if err := decode(w, r, &n); err != nil {
		return err
	}
	if !n.validate() {
		return apiError{400, "invalid_notification"}
	}
	key := r.Header.Get("Idempotency-Key")
	if !identifier.MatchString(key) {
		return apiError{400, "invalid_idempotency_key"}
	}
	payload, _ := json.Marshal(n)
	ph := hash(string(payload))
	kh := hash(key)
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Context().Err() != nil {
		return apiError{503, "request_expired"}
	}
	if err := g.cleanup(); err != nil {
		return err
	}
	var d Destination
	var ciphertext []byte
	var dh, stored, deviceID string
	err := g.db.QueryRow(`SELECT b.send_hash,b.connection_id,d.platform,d.app_id,d.environment,d.token_cipher,d.destination_hash,d.id FROM bindings b JOIN devices d ON d.id=b.device_id WHERE b.id=? AND b.active=1 AND d.active=1`, id).Scan(&stored, &n.ConnectionID, &d.Platform, &d.AppID, &d.Environment, &ciphertext, &dh, &deviceID)
	if err == sql.ErrNoRows {
		return denied()
	}
	if err != nil {
		return err
	}
	if !capMatches(bearer(r), stored) {
		return denied()
	}
	now := g.cfg.Now().Unix()
	var existingHash, state, code string
	var attempts int
	var lease, expires int64
	err = g.db.QueryRow(`SELECT payload_hash,state,code,attempts,lease_until,expires FROM receipts WHERE binding_id=? AND key_hash=?`, id, kh).Scan(&existingHash, &state, &code, &attempts, &lease, &expires)
	if err == nil {
		if existingHash != ph {
			return apiError{409, "idempotency_conflict"}
		}
		if state == "accepted" || state == "permanent_failure" {
			receiptResponse(w, state, code)
			return nil
		}
		if now < lease {
			receiptResponse(w, "retryable", "handoff_pending")
			return nil
		}
		if now >= expires || attempts >= 5 {
			_, err = g.db.Exec(`UPDATE receipts SET state='permanent_failure',code='expired_or_exhausted' WHERE binding_id=? AND key_hash=?`, id, kh)
			if err != nil {
				return err
			}
			receiptResponse(w, "permanent_failure", "expired_or_exhausted")
			return nil
		}
	}
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows {
		expires = now + int64(receiptRetryWindow/time.Second)
		_, err = g.db.Exec(`INSERT INTO receipts(binding_id,key_hash,payload_hash,state,code,attempts,lease_until,expires,created) VALUES(?,?,?,'pending','handoff_pending',0,0,?,?)`, id, kh, ph, expires, now)
		if err != nil {
			return err
		}
	}
	_, err = g.db.Exec(`UPDATE receipts SET state='pending',code='handoff_pending',attempts=attempts+1,lease_until=? WHERE binding_id=? AND key_hash=?`, now+15, id, kh)
	if err != nil {
		return err
	}
	d.Token, err = g.decrypt(ciphertext, dh)
	if err != nil {
		return err
	}
	n.Deadline = g.cfg.Now().Add(time.Duration(n.TTL) * time.Second)
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	result := g.provider.Send(ctx, d, n)
	state = "retryable"
	code = "provider_unavailable"
	if result.Code == "handoff_unknown" {
		code = "handoff_unknown"
	}
	if result.Accepted {
		state = "accepted"
		code = "provider_accepted"
	} else if result.Permanent {
		state = "permanent_failure"
		code = "provider_rejected"
	}
	if result.InvalidToken {
		code = "invalid_token"
	}
	tx, err := g.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE receipts SET state=?,code=?,lease_until=? WHERE binding_id=? AND key_hash=?`, state, code, g.cfg.Now().Unix()+5, id, kh); err != nil {
		return err
	}
	if result.InvalidToken {
		if _, err = tx.Exec(`UPDATE bindings SET active=0 WHERE device_id=?`, deviceID); err != nil {
			return err
		}
		if _, err = tx.Exec(`UPDATE devices SET active=0 WHERE id=?`, deviceID); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	receiptResponse(w, state, code)
	return nil
}
func (g *Gateway) cleanup() error {
	now := g.cfg.Now().Unix()
	for _, query := range []struct {
		sql    string
		cutoff int64
	}{{`DELETE FROM registrations WHERE expires<?`, now}, {`DELETE FROM receipts WHERE created<?`, now - 7*24*3600}, {`DELETE FROM rates WHERE bucket<?`, now/600 - 1}} {
		if _, err := g.db.Exec(query.sql, query.cutoff); err != nil {
			return err
		}
	}
	return nil
}
func envRequired(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}
func decimal(value int64) string { return strconv.FormatInt(value, 10) }

func (g *Gateway) CleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.mu.Lock()
			_ = g.cleanup()
			g.mu.Unlock()
		}
	}
}
