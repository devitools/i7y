package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestQueueRetriesAndExpires(t *testing.T) {
	fail := true
	received := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("credential missing")
		}
		if fail {
			w.WriteHeader(503)
			return
		}
		received++
		w.Write([]byte(`{}`))
	}))
	defer api.Close()
	a := newAgent(Config{URL: api.URL, Token: "secret", StateDir: t.TempDir()})
	s := Snapshot{SampleID: "sample"}
	if e := a.enqueue(s); e != nil {
		t.Fatal(e)
	}
	if a.flush(context.Background()) == nil {
		t.Fatal("failed delivery accepted")
	}
	files, _ := filepath.Glob(filepath.Join(a.cfg.StateDir, "*.json"))
	if len(files) != 1 {
		t.Fatal("queue lost")
	}
	fail = false
	if e := a.flush(context.Background()); e != nil {
		t.Fatal(e)
	}
	if received != 1 {
		t.Fatal("not delivered")
	}
	if e := a.enqueue(s); e != nil {
		t.Fatal(e)
	}
	files, _ = filepath.Glob(filepath.Join(a.cfg.StateDir, "*.json"))
	past := time.Now().Add(-25 * time.Hour)
	os.Chtimes(files[0], past, past)
	if e := a.flush(context.Background()); e != nil {
		t.Fatal(e)
	}
	if received != 1 {
		t.Fatal("expired sample sent")
	}
}
func TestDockerDiscoveryAndPartialCollection(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "example")
	os.Mkdir(project, 0700)
	app := filepath.Join(project, "app")
	os.Mkdir(app, 0700)
	os.WriteFile(filepath.Join(app, "compose.yaml"), []byte("services: {}"), 0600)
	os.WriteFile(filepath.Join(project, "compose.yaml"), []byte("services: {}"), 0600)
	socketDir, err := os.MkdirTemp("/tmp", "i7y-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDir)
	socket := filepath.Join(socketDir, "docker.sock")
	listener, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	missing := false
	image := "nginx:stable"
	dockerName := "/web"
	oneoff := "False"
	dockerID := "abcdef0123456789"
	registeredPath := project
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/version":
			w.Write([]byte(`{"ApiVersion":"1.40"}`))
		case "/v1.40/containers/json":
			json.NewEncoder(w).Encode([]map[string]string{{"Id": dockerID}})
		case "/v1.40/containers/" + dockerID + "/json":
			if missing {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"Id": dockerID, "Name": dockerName, "Image": "sha256:abc", "Config": map[string]any{"Image": image, "Labels": map[string]string{"com.docker.compose.project": "example", "com.docker.compose.service": "web", "com.docker.compose.oneoff": oneoff, "com.docker.compose.project.working_dir": app}}, "State": map[string]any{"Status": "running"}})
		case "/v1.40/containers/" + dockerID + "/stats":
			w.Write([]byte(`{"cpu_stats":{"cpu_usage":{"total_usage":200},"system_cpu_usage":2000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},"memory_stats":{"usage":1000,"limit":2000,"stats":{"total_inactive_file":100}}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	server.Listener = listener
	server.Start()
	defer server.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"projects": []Project{{Key: "registered", Name: "example", Path: registeredPath}}, "containers": []map[string]string{{"name": "web", "path": registeredPath, "project_name": "example"}}})
	}))
	defer api.Close()
	link := filepath.Join(socketDir, "projects-link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	registeredPath = filepath.Join(link, "example")
	physicalProject, err := filepath.EvalSymlinks(app)
	if err != nil {
		t.Fatal(err)
	}
	a := newAgent(Config{URL: api.URL, Socket: socket, Roots: []string{root, link}})
	s := a.collect(context.Background())
	if !s.DockerComplete || !s.DiscoveryComplete || len(s.Projects) != 1 || len(s.Containers) != 1 {
		t.Fatalf("unexpected discovery: %+v", s)
	}
	c := s.Containers[0]
	if c.ProjectKey != "registered" || s.Projects[0].Path != physicalProject || c.CPU == nil || *c.CPU != 20 || c.Memory == nil || *c.Memory != 900 {
		t.Fatalf("wrong metrics: %+v", c)
	}
	image = "nginx:updated"
	s = a.collect(context.Background())
	if len(s.Containers) != 1 || s.Containers[0].Image != image || s.Containers[0].ProjectKey != "registered" {
		t.Fatal("image update did not preserve the project association")
	}
	fast := a.collectWithMetrics(context.Background(), false)
	if fast.MetricsComplete || !fast.DockerComplete || len(fast.Containers) != 1 || fast.Containers[0].CPU != nil || fast.Reason != "docker_event" {
		t.Fatalf("invalid event reconciliation: %+v", fast)
	}
	dockerName = "/" + dockerID[:12] + "_web"
	renamed := a.collectWithMetrics(context.Background(), false)
	if len(renamed.Containers) != 1 || renamed.Containers[0].Name != "web" || renamed.Containers[0].ProjectKey != "registered" {
		t.Fatalf("Compose recreation created another identity: %+v", renamed)
	}
	oneoff = "True"
	task := a.collectWithMetrics(context.Background(), false)
	if !task.DockerComplete || len(task.Containers) != 0 || len(task.Projects) != 1 {
		t.Fatalf("one-off task polluted inventory: %+v", task)
	}
	oneoff = "False"
	missing = true
	s = a.collect(context.Background())
	if s.DockerComplete {
		t.Fatal("inspection failure marked complete")
	}
}

func TestContainerProjectRecognizesComposeSubdirectory(t *testing.T) {
	realRoot := t.TempDir()
	parent := filepath.Join(realRoot, "projects", "example")
	app := filepath.Join(parent, "app")
	sibling := filepath.Join(realRoot, "projects", "example-other", "app")
	for _, dir := range []string{app, sibling} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	alias := filepath.Join(t.TempDir(), "projects")
	if err := os.Symlink(filepath.Join(realRoot, "projects"), alias); err != nil {
		t.Fatal(err)
	}
	registered := Project{Key: "existing", Name: "example", Path: filepath.Join(alias, "example")}
	duplicate := Project{Key: "duplicate", Name: "example-compose", Path: app}
	inventory := Inventory{Projects: []Project{duplicate, registered}}
	hint := struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		ProjectName string `json:"project_name"`
	}{Name: "web", Path: registered.Path, ProjectName: registered.Name}
	inventory.Containers = append(inventory.Containers, hint)
	a := newAgent(Config{Roots: []string{alias}})
	got, ok := a.containerProject("web", app, inventory)
	if !ok || got.Path != registered.Path || got.Name != registered.Name {
		t.Fatalf("existing association not preserved: %+v %v", got, ok)
	}
	inventory.Projects = []Project{registered, {Name: "infrastructure", Path: realRoot}}
	got, ok = a.containerProject("new-web", app, inventory)
	if !ok || got.Path != registered.Path {
		t.Fatalf("new container not associated with nearest project: %+v %v", got, ok)
	}
	if _, ok = a.containerProject("web", sibling, inventory); ok {
		t.Fatal("sibling matched by prefix or infrastructure root")
	}
	if _, ok = a.containerProject("web", filepath.Join(app, "missing"), inventory); ok {
		t.Fatal("unresolved path was guessed")
	}
	inventory.Projects = append(inventory.Projects, Project{Name: "ambiguous", Path: parent})
	if _, ok = a.containerProject("new-web", app, inventory); ok {
		t.Fatal("ambiguous equivalent projects matched")
	}
}
