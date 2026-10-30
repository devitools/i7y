package main

import (
	"strings"
	"time"
	_ "time/tzdata"
)

func (n Notification) validDisplayDeadline() bool {
	if n.DeadlineAt == "" {
		return !strings.Contains(n.Resource, "{deadline}")
	}
	if !strings.Contains(n.Resource, "{deadline}") || (n.Locale != "en" && n.Locale != "pt-BR" && n.Locale != "uk") {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, n.DeadlineAt); err != nil {
		return false
	}
	if n.TimeZone == "" || len(n.TimeZone) > 80 {
		return false
	}
	_, err := time.LoadLocation(n.TimeZone)
	return err == nil
}

func (n Notification) renderDisplayDeadline() Notification {
	if n.DeadlineAt == "" {
		return n
	}
	deadline, err := time.Parse(time.RFC3339Nano, n.DeadlineAt)
	if err != nil {
		return n
	}
	location, err := time.LoadLocation(n.TimeZone)
	if err != nil {
		return n
	}
	layout := "01/02/2006, 3:04:05 PM"
	if n.Locale == "pt-BR" {
		layout = "02/01/2006, 15:04:05"
	}
	if n.Locale == "uk" {
		layout = "02.01.2006, 15:04:05"
	}
	n.Resource = strings.ReplaceAll(n.Resource, "{deadline}", deadline.In(location).Format(layout))
	return n
}
