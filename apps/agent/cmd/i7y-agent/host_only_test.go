package main

import (
	"context"
	"net/http"
	"testing"
)

type rejectHostRequests struct{ t *testing.T }

func (r rejectHostRequests) RoundTrip(*http.Request) (*http.Response, error) {
	r.t.Fatal("host mode accessed Docker or inventory")
	return nil, nil
}
func TestHostOnlyDoesNotReconcileInventory(t *testing.T) {
	a := newAgent(Config{Mode: "host", Roots: []string{t.TempDir()}})
	a.api = &http.Client{Transport: rejectHostRequests{t}}
	a.docker = &http.Client{Transport: rejectHostRequests{t}}
	s := a.collectWithMetrics(context.Background(), false)
	if s.CollectionMode != "host" || s.DockerComplete || s.DiscoveryComplete || len(s.Projects) != 0 || len(s.Containers) != 0 {
		t.Fatalf("unsafe host snapshot: %+v", s)
	}
	if _, ok := s.Host["disks"]; !ok {
		t.Fatal("host disks not collected")
	}
	if newAgent(Config{}).cfg.Mode != "docker" {
		t.Fatal("default mode changed")
	}
}
