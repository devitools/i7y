package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxDeviceBindings = 32

type GenericNotification struct {
	EventID string            `json:"event_id"`
	Type    string            `json:"type"`
	Title   string            `json:"title"`
	Body    string            `json:"body"`
	Data    map[string]string `json:"data"`
	TTL     int               `json:"ttl"`
}

func migrateRegistrations(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(registrations)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, typ string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, column := range []struct{ name, definition string }{{"api_version", "INTEGER NOT NULL DEFAULT 1"}, {"device_id", "TEXT NOT NULL DEFAULT ''"}, {"management_hash", "TEXT NOT NULL DEFAULT ''"}} {
		if !columns[column.name] {
			if _, err = db.Exec(`ALTER TABLE registrations ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
				return err
			}
		}
	}
	return nil
}

func (g *Gateway) registerV2(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Destination
		DeviceID string `json:"device_id,omitempty"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if (body.DeviceID == "") != (r.Header.Get("Authorization") == "") {
		return denied()
	}
	return g.startRegistration(w, r, body.Destination, body.DeviceID)
}

func (g *Gateway) confirmRotation(w http.ResponseWriter, r *http.Request, device, storedHash, dh, platform, app, environment string, ciphertext []byte) error {
	if !capMatches(bearer(r), storedHash) {
		return denied()
	}
	tx, err := g.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentHash, oldDH string
	err = tx.QueryRow(`SELECT management_hash,destination_hash FROM devices WHERE id=? AND active=1 AND platform=? AND app_id=? AND environment=?`, device, platform, app, environment).Scan(&currentHash, &oldDH)
	if err == sql.ErrNoRows || err == nil && currentHash != storedHash {
		return denied()
	}
	if err != nil {
		return err
	}
	var previous string
	err = tx.QueryRow(`SELECT id FROM devices WHERE destination_hash=? AND id!=?`, dh, device).Scan(&previous)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if previous != "" {
		if _, err = tx.Exec(`UPDATE bindings SET active=0 WHERE device_id=?`, previous); err != nil {
			return err
		}
		if _, err = tx.Exec(`UPDATE devices SET active=0,destination_hash=? WHERE id=?`, "revoked:"+previous, previous); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`UPDATE devices SET destination_hash=?,token_cipher=? WHERE id=?`, dh, ciphertext, device); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM registrations WHERE destination_hash IN (?,?) OR device_id=?`, dh, oldDH, device); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	jsonResponse(w, 200, map[string]string{"device_id": device, "management_token": bearer(r)})
	return nil
}

func reservedDataKey(key string) bool {
	switch key {
	case "kind", "type", "app_id", "platform", "environment", "connection_id", "server_instance_id", "event_id", "registration_id", "nonce", "from", "message_type":
		return true
	}
	return strings.HasPrefix(key, "google.") || strings.HasPrefix(key, "gcm.")
}

func (n GenericNotification) validate() bool {
	if !identifier.MatchString(n.EventID) || !identifier.MatchString(n.Type) || !cleanString(n.Title, 120) || !cleanString(n.Body, 512) || n.TTL < 1 || n.TTL > 60 || len(n.Data) > 32 {
		return false
	}
	size := 0
	for key, value := range n.Data {
		if !identifier.MatchString(key) || reservedDataKey(key) || !utf8.ValidString(value) || len(value) > 512 {
			return false
		}
		size += len(key) + len(value)
	}
	return size <= 2048
}

func (g *Gateway) notifyV2(w http.ResponseWriter, r *http.Request, id string) error {
	var body GenericNotification
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !body.validate() {
		return apiError{400, "invalid_notification"}
	}
	payload, _ := json.Marshal(body)
	n := Notification{EventID: body.EventID, Title: body.Title, Resource: body.Body, TTL: body.TTL, Generic: &body}
	return g.sendNotification(w, r, id, n, hash("v2:"+string(payload)))
}
