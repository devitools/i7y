package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestContainerLocationEvidence(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "analytics.example", "app")
	second := filepath.Join(root, "other.example", "app")
	for _, p := range []string{first, second} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(first, "docker-compose.yml")
	if err := os.WriteFile(file, []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(filepath.Dir(first), alias); err != nil {
		t.Fatal(err)
	}
	inventory := Inventory{Projects: []Project{{Key: "analytics", Name: "analytics.example", Path: alias}, {Key: "other", Name: "other.example", Path: filepath.Dir(second)}}}
	a := newAgent(Config{Roots: []string{root}})
	d := dockerContainer{Mounts: []dockerMount{{Type: "volume", Source: first}, {Type: "bind", Source: first}}}
	d.Config.Labels = map[string]string{"com.docker.compose.project": "analyticsexample"}
	p, ok := a.containerLocation("web", d, inventory)
	if !ok || p.Key != "analytics" {
		t.Fatalf("bind mount not matched through symlink: %+v", p)
	}
	d.Mounts = append(d.Mounts, dockerMount{Type: "bind", Source: second})
	if _, ok := a.containerLocation("web", d, inventory); ok {
		t.Fatal("conflicting mounts were guessed")
	}
	d.Config.Labels["com.docker.compose.project.config_files"] = file
	p, ok = a.containerLocation("web", d, inventory)
	if !ok || p.Key != "analytics" || !sameProjectPath(p.Path, first) {
		t.Fatal("Compose metadata did not preserve the actual configuration directory")
	}
	d.Config.Labels["com.docker.compose.project.working_dir"] = root
	p, ok = a.containerLocation("web", d, inventory)
	if !ok || !sameProjectPath(p.Path, first) {
		t.Fatal("working directory overrode the Compose file directory")
	}
	d.Config.Labels["com.docker.compose.project.working_dir"] = first
	d.Config.Labels["com.docker.compose.project.config_files"] = "docker-compose.yml"
	p, ok = a.containerLocation("web", d, inventory)
	if !ok || !sameProjectPath(p.Path, first) {
		t.Fatal("relative Compose file was not resolved against its working directory")
	}
	delete(d.Config.Labels, "com.docker.compose.project.working_dir")
	delete(d.Config.Labels, "com.docker.compose.project.config_files")
	d.Mounts = []dockerMount{{Type: "volume", Source: first}}
	if _, ok := a.containerLocation("db", d, inventory); ok {
		t.Fatal("named volume treated as project path")
	}
	d.Mounts = []dockerMount{{Type: "bind", Source: root}}
	if _, ok := a.containerLocation("web", d, inventory); ok {
		t.Fatal("broad discovery root treated as project")
	}
}

func TestVolumeDiscoveryAndComposeGroup(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "analytics.example", "app")
	other := filepath.Join(root, "other.example", "app")
	for _, p := range []string{app, other} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "compose.yaml"), []byte("services: {}"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	template := filepath.Join(app, ".environment", "template")
	if err := os.MkdirAll(template, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(template, "compose.yaml"), []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	conflict := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(Inventory{}) }))
	defer api.Close()
	docker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/version":
			w.Write([]byte(`{"ApiVersion":"1.40"}`))
		case "/v1.40/containers/json":
			json.NewEncoder(w).Encode([]map[string]any{{"Id": "db", "Names": []string{"/db"}}, {"Id": "web", "Names": []string{"/web"}}, {"Id": "other", "Names": []string{"/other"}}})
		default:
			id := filepath.Base(filepath.Dir(r.URL.Path))
			mount := []map[string]string{{"Type": "volume", "Source": "/var/lib/docker/volumes/db/_data"}}
			if id == "web" {
				mount = []map[string]string{{"Type": "bind", "Source": app}}
			}
			if id == "other" {
				mount = nil
				if conflict {
					mount = []map[string]string{{"Type": "bind", "Source": other}}
				}
			}
			group := "analytics"
			if id == "other" && !conflict {
				group = "separate"
			}
			json.NewEncoder(w).Encode(map[string]any{"Id": id, "Name": "/" + id, "Mounts": mount, "Config": map[string]any{"Image": "example:1", "Labels": map[string]string{"com.docker.compose.project": group}}, "State": map[string]string{"Status": "running"}})
		}
	}))
	defer docker.Close()
	a := newAgent(Config{URL: api.URL, Roots: []string{root}})
	a.docker = docker.Client()
	a.docker.Transport = rewriteDockerTransport{base: docker.Client().Transport, url: docker.URL}
	snapshot := a.collectWithMetrics(context.Background(), false)
	paths := map[string]string{}
	for _, p := range snapshot.Projects {
		paths[p.Key] = p.Path
	}
	for _, c := range snapshot.Containers {
		if (c.Name == "db" || c.Name == "web") && !sameProjectPath(paths[c.ProjectKey], app) {
			t.Fatalf("%s did not share physical project: %+v", c.Name, snapshot)
		}
		if c.Name == "other" && paths[c.ProjectKey] != "" {
			t.Fatal("different Compose group inherited path")
		}
	}
	for _, p := range snapshot.Projects {
		if sameProjectPath(p.Path, other) {
			t.Fatal("unused Compose folder reported as a new project")
		}
	}
	conflict = true
	snapshot = a.collectWithMetrics(context.Background(), false)
	paths = map[string]string{}
	for _, p := range snapshot.Projects {
		paths[p.Key] = p.Path
	}
	for _, c := range snapshot.Containers {
		if c.Name == "db" && paths[c.ProjectKey] != "" {
			t.Fatal("ambiguous Compose group assigned database path")
		}
	}
}

type rewriteDockerTransport struct {
	base http.RoundTripper
	url  string
}

func (t rewriteDockerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	target, _ := http.NewRequest(r.Method, t.url+r.URL.RequestURI(), nil)
	copy.URL = target.URL
	return t.base.RoundTrip(copy)
}

func TestComposeDirectoryUsesActualFileLocation(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "deployment")
	if err := os.Mkdir(app, 0700); err != nil {
		t.Fatal(err)
	}
	if got := composeDirectory(root); !sameProjectPath(got, root) {
		t.Fatal("app suffix invented without Compose file")
	}
	if err := os.WriteFile(filepath.Join(app, "docker-compose.yml"), []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := composeDirectory(root); !sameProjectPath(got, app) {
		t.Fatalf("Compose folder not detected: %s", got)
	}
	if got := composeDirectory(app); !sameProjectPath(got, app) {
		t.Fatal("Compose folder not idempotent")
	}
	if err := os.WriteFile(filepath.Join(root, "compose.yaml"), []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := composeDirectory(root); !sameProjectPath(got, root) {
		t.Fatal("ambiguous Compose folders should not be guessed")
	}
	if got := composeDirectory(""); got != "" {
		t.Fatal("empty path converted to a local folder")
	}
}
