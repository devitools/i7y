package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDockerEventStreamFilteringReconnectAndCancellation(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "i7y-events-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	sinceQuery := make(chan string, 2)
	release := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version" {
			fmt.Fprint(w, `{"ApiVersion":"1.40"}`)
			return
		}
		if r.URL.Path != "/v1.40/events" {
			w.WriteHeader(404)
			return
		}
		sinceQuery <- r.URL.Query().Get("since")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprintln(w, `{"Type":"container","Action":"exec_start","time":123}`)
		fmt.Fprintln(w, `{"Type":"container","Action":"destroy","time":124}`)
		w.(http.Flusher).Flush()
	}))
	server.Listener = listener
	server.Start()
	defer server.Close()
	a := newAgent(Config{Socket: socket})
	changes := make(chan struct{}, 1)
	var cursor int64
	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { done <- a.dockerEvents(ctx, changes, &cursor) }()
	select {
	case <-changes:
	case <-time.After(2 * time.Second):
		t.Fatal("no connection reconciliation")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not finish")
	}
	if cursor != 124 {
		t.Fatal("cursor not advanced")
	}
	select {
	case <-changes:
	default:
		t.Fatal("destroy not signaled")
	}
	<-sinceQuery
	go func() { done <- a.dockerEvents(ctx, changes, &cursor) }()
	if value := <-sinceQuery; value != "124" {
		t.Fatal("reconnect cursor missing", value)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not cancel")
	}
	for _, action := range []string{"start", "stop", "die", "destroy", "pause", "unpause", "rename", "health_status: healthy", "health_status: unhealthy"} {
		if !relevantDockerEvent(action) {
			t.Fatal("event ignored", action)
		}
	}
	if relevantDockerEvent("exec_start") {
		t.Fatal("irrelevant exec triggered reconciliation")
	}
}
