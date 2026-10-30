package main

import (
	"strings"
	"testing"
)

func TestDisplayDeadlineUsesDeviceTimezoneAndLocale(t *testing.T) {
	n := Notification{Resource: "Deadline: {deadline}.", DeadlineAt: "2026-10-29T22:09:32.000Z", Locale: "en", TimeZone: "America/Fortaleza"}
	for locale, want := range map[string]string{"en": "10/29/2026, 7:09:32 PM", "pt-BR": "29/10/2026, 19:09:32", "uk": "29.10.2026, 19:09:32"} {
		n.Locale = locale
		if !n.validDisplayDeadline() || n.renderDisplayDeadline().Resource != "Deadline: "+want+"." {
			t.Fatal(locale, n.renderDisplayDeadline())
		}
	}
	n.Locale = "en"
	n.TimeZone = "America/New_York"
	n.DeadlineAt = "2026-01-01T17:00:00Z"
	if !strings.Contains(n.renderDisplayDeadline().Resource, "12:00:00 PM") {
		t.Fatal("winter offset")
	}
	n.DeadlineAt = "2026-07-01T17:00:00Z"
	if !strings.Contains(n.renderDisplayDeadline().Resource, "1:00:00 PM") {
		t.Fatal("summer offset")
	}
	n.TimeZone = "Invalid/Zone"
	if n.validDisplayDeadline() {
		t.Fatal("invalid timezone accepted")
	}
	n.TimeZone = "UTC"
	n.DeadlineAt = "bad"
	if n.validDisplayDeadline() {
		t.Fatal("invalid date accepted")
	}
	if (Notification{Resource: "Deadline {deadline}"}).validDisplayDeadline() {
		t.Fatal("unresolved deadline accepted")
	}
	if !(Notification{Resource: "Open incident"}).validDisplayDeadline() {
		t.Fatal("legacy notification rejected")
	}
}
