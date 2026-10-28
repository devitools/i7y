package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev"

type Config struct {
	Mode     string   `json:"mode"`
	URL      string   `json:"url"`
	Token    string   `json:"token"`
	Socket   string   `json:"docker_socket"`
	StateDir string   `json:"state_dir"`
	Roots    []string `json:"roots"`
}
type Project struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Path string `json:"path"`
}
type Container struct {
	Name        string   `json:"name"`
	ProjectKey  string   `json:"project_key"`
	Image       string   `json:"image"`
	ImageID     string   `json:"image_id"`
	ID          string   `json:"docker_id"`
	State       string   `json:"state"`
	Health      string   `json:"health"`
	Restarts    int      `json:"restarts"`
	Started     string   `json:"started_at"`
	Finished    string   `json:"finished_at"`
	ExitCode    int      `json:"exit_code"`
	CPU         *float64 `json:"cpu_percent"`
	Memory      *uint64  `json:"memory_bytes"`
	MemoryLimit *uint64  `json:"memory_limit_bytes"`
}
type Snapshot struct {
	CollectionMode    string         `json:"collection_mode,omitempty"`
	MetricsComplete   bool           `json:"metrics_complete"`
	Reason            string         `json:"reason,omitempty"`
	Version           int            `json:"version"`
	SampleID          string         `json:"sample_id"`
	ObservedAt        string         `json:"observed_at"`
	AgentVersion      string         `json:"agent_version"`
	Host              map[string]any `json:"host"`
	DockerComplete    bool           `json:"docker_complete"`
	DiscoveryComplete bool           `json:"discovery_complete"`
	Projects          []Project      `json:"projects"`
	Containers        []Container    `json:"containers"`
	Errors            []string       `json:"errors"`
}
type Inventory struct {
	Projects   []Project `json:"projects"`
	Containers []struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		ProjectName string `json:"project_name"`
	} `json:"containers"`
}
type Agent struct {
	cfg        Config
	docker     *http.Client
	api        *http.Client
	apiVersion string
}

func newAgent(c Config) *Agent {
	if c.Mode == "" {
		c.Mode = "docker"
	}
	if c.Socket == "" {
		c.Socket = "/var/run/docker.sock"
	}
	if c.StateDir == "" {
		c.StateDir = "/var/lib/i7y-agent"
	}
	if len(c.Roots) == 0 {
		c.Roots = []string{"/projects", "/usr/share/tevun"}
	}
	tr := &http.Transport{ResponseHeaderTimeout: 10 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", c.Socket)
	}}
	return &Agent{cfg: c, docker: &http.Client{Transport: tr, Timeout: 12 * time.Second}, api: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (a *Agent) dockerGet(ctx context.Context, path string, out any) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://docker"+path, nil)
	r, e := a.docker.Do(req)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("Docker HTTP %d", r.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(out)
}
func (a *Agent) apiCall(ctx context.Context, method, path string, body []byte, out any) error {
	req, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.cfg.URL, "/")+path, bytes.NewReader(body))
	if e != nil {
		return errors.New("invalid API URL")
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	r, e := a.api.Do(req)
	if e != nil {
		return errors.New("API connection failed")
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return fmt.Errorf("API HTTP %d", r.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(out)
	}
	return nil
}

type dockerMount struct {
	Type   string
	Source string
}

type dockerContainer struct {
	Mounts       []dockerMount
	ID           string `json:"Id"`
	Name         string
	Image        string
	RestartCount int
	Config       struct {
		Image  string
		Labels map[string]string
	}
	State struct {
		Status     string
		StartedAt  string
		FinishedAt string
		ExitCode   int
		Health     *struct{ Status string }
	}
}

func projectContains(parent, child string) bool {
	if !filepath.IsAbs(parent) || !filepath.IsAbs(child) || filepath.Clean(parent) == string(os.PathSeparator) {
		return false
	}
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return false
	}
	resolvedChild, err := filepath.EvalSymlinks(child)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(resolvedParent, resolvedChild)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func (a *Agent) containerProject(name, path string, inventory Inventory) (Project, bool) {
	hints := []Project{}
	for _, c := range inventory.Containers {
		if c.Name == name && c.Path != "" && (path == "" || projectContains(c.Path, path)) {
			hints = append(hints, Project{Name: c.ProjectName, Path: c.Path})
		}
	}
	if len(hints) == 1 {
		hint := hints[0]
		for _, p := range inventory.Projects {
			if sameProjectPath(p.Path, hint.Path) {
				hint.Key = p.Key
				break
			}
		}
		return hint, true
	}
	if len(hints) > 1 {
		return Project{}, false
	}
	best := Project{}
	bestLength := -1
	ambiguous := false
	for _, p := range inventory.Projects {
		if !projectContains(p.Path, path) {
			continue
		}
		broad := false
		for _, root := range a.cfg.Roots {
			if projectContains(p.Path, root) {
				broad = true
				break
			}
		}
		if broad {
			continue
		}
		resolved, err := filepath.EvalSymlinks(p.Path)
		if err != nil {
			continue
		}
		if len(resolved) > bestLength {
			best = p
			bestLength = len(resolved)
			ambiguous = false
		} else if len(resolved) == bestLength {
			ambiguous = true
		}
	}
	return best, bestLength >= 0 && !ambiguous
}

func composeDirectory(path string) string {
	if !filepath.IsAbs(path) {
		return path
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	path = resolved
	for _, name := range []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"} {
		if info, err := os.Stat(filepath.Join(path, name)); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	found := ""
	ambiguous := false
	filepath.WalkDir(path, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(path, file)
		if entry.IsDir() {
			if strings.Count(rel, string(os.PathSeparator)) >= 1 || entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		switch entry.Name() {
		case "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml":
			dir := filepath.Dir(file)
			if found != "" && found != dir {
				ambiguous = true
			}
			found = dir
		}
		return nil
	})
	if found != "" && !ambiguous {
		return found
	}
	return path
}

func sameProjectPath(first, second string) bool {
	a, ea := filepath.EvalSymlinks(first)
	b, eb := filepath.EvalSymlinks(second)
	return ea == nil && eb == nil && a == b
}

func (a *Agent) containerLocation(name string, d dockerContainer, inventory Inventory) (Project, bool) {
	fromPath := func(path string) (Project, bool) {
		if !filepath.IsAbs(path) {
			return Project{}, false
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return Project{}, false
		}
		if info, err := os.Stat(resolved); err != nil || !info.IsDir() {
			return Project{}, false
		}
		if p, ok := a.containerProject(name, resolved, inventory); ok {
			p.Path = resolved
			return p, true
		}
		return Project{Name: d.Config.Labels["com.docker.compose.project"], Path: resolved}, true
	}
	choose := func(candidates []Project) (Project, bool) {
		if len(candidates) == 0 {
			return Project{}, false
		}
		first := candidates[0]
		for _, p := range candidates[1:] {
			if !sameProjectPath(first.Path, p.Path) {
				return Project{}, false
			}
		}
		return first, true
	}
	candidates := []Project{}
	for _, file := range strings.Split(d.Config.Labels["com.docker.compose.project.config_files"], ",") {
		if file != "" && !filepath.IsAbs(file) {
			if dir := d.Config.Labels["com.docker.compose.project.working_dir"]; filepath.IsAbs(dir) {
				file = filepath.Join(dir, file)
			}
		}
		if !filepath.IsAbs(file) {
			continue
		}
		if info, err := os.Stat(file); err != nil || !info.Mode().IsRegular() {
			continue
		}
		if p, ok := fromPath(filepath.Dir(file)); ok {
			candidates = append(candidates, p)
		}
	}
	if len(candidates) > 0 {
		return choose(candidates)
	}
	if path := d.Config.Labels["com.docker.compose.project.working_dir"]; path != "" {
		if p, ok := fromPath(path); ok {
			return p, true
		}
	}
	for _, mount := range d.Mounts {
		if mount.Type != "bind" {
			continue
		}
		if p, ok := a.containerProject(name, mount.Source, inventory); ok {
			candidates = append(candidates, p)
		}
	}
	if len(candidates) > 0 {
		return choose(candidates)
	}
	if p, ok := a.containerProject(name, "", inventory); ok {
		if _, err := filepath.EvalSymlinks(p.Path); err == nil {
			return p, true
		}
	}
	return Project{}, false
}

func (a *Agent) collect(ctx context.Context) Snapshot { return a.collectWithMetrics(ctx, true) }
func (a *Agent) collectWithMetrics(ctx context.Context, metrics bool) Snapshot {
	id := make([]byte, 16)
	if _, e := rand.Read(id); e != nil {
		panic(e)
	}
	s := Snapshot{Version: 1, SampleID: hex.EncodeToString(id), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), AgentVersion: version, Projects: []Project{}, Containers: []Container{}, Errors: []string{}, DiscoveryComplete: true}
	s.MetricsComplete = metrics
	s.Reason = "periodic"
	if !metrics {
		s.Reason = "docker_event"
	}
	s.Host = hostMetrics(ctx, &s.Errors)
	s.CollectionMode = a.cfg.Mode
	if a.cfg.Mode == "host" {
		s.DiscoveryComplete = false
		return s
	}
	var inventory Inventory
	if e := a.apiCall(ctx, "GET", "/api/i7y/telemetry/v1/config", nil, &inventory); e != nil {
		s.Errors = append(s.Errors, "inventory configuration unavailable")
		s.DiscoveryComplete = false
	}
	directories := map[string]string{}
	locate := func(path string) string {
		if dir, ok := directories[path]; ok {
			return dir
		}
		dir := composeDirectory(path)
		directories[path] = dir
		return dir
	}
	for i := range inventory.Projects {
		inventory.Projects[i].Path = locate(inventory.Projects[i].Path)
	}
	for i := range inventory.Containers {
		inventory.Containers[i].Path = locate(inventory.Containers[i].Path)
	}
	projects := map[string]Project{}
	canonical := map[string]string{}
	add := func(name, path, key string) string {
		if path != "" {
			path = filepath.Clean(path)
			resolved, err := filepath.EvalSymlinks(path)
			if err == nil {
				if prior, found := canonical[resolved]; found {
					if key == "" || strings.HasPrefix(key, "compose:") || key == prior || prior != resolved {
						return prior
					}
					delete(projects, prior)
				}
				path = resolved
			}
			if key == "" || strings.HasPrefix(key, "compose:") {
				key = path
			}
			if err == nil {
				canonical[resolved] = key
			}
		}
		if key == "" {
			key = "unassigned"
		}
		if name == "" {
			name = "Unassigned"
		}
		projects[key] = Project{key, name, path}
		return key
	}
	for _, p := range inventory.Projects {
		if p.Path != "" {
			if _, e := os.Stat(p.Path); e == nil {
				add(p.Name, p.Path, p.Key)
			} else if !os.IsNotExist(e) {
				s.DiscoveryComplete = false
				s.Errors = append(s.Errors, "project path inaccessible")
			}
		}
	}
	for _, root := range a.cfg.Roots {
		if _, e := os.Stat(root); os.IsNotExist(e) {
			continue
		}
		resolved, resolveErr := filepath.EvalSymlinks(root)
		if resolveErr != nil {
			s.DiscoveryComplete = false
			s.Errors = append(s.Errors, "discovery root unresolved")
			continue
		}
		if _, known := canonical[resolved]; known {
			continue
		}
		e := filepath.WalkDir(resolved, func(path string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			rel, _ := filepath.Rel(resolved, path)
			if d.IsDir() {
				if strings.Count(rel, string(os.PathSeparator)) >= 4 || d.Name() == ".git" || d.Name() == "node_modules" || d.Name() == "vendor" {
					return filepath.SkipDir
				}
				for _, name := range []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"} {
					if info, err := os.Stat(filepath.Join(path, name)); err == nil && info.Mode().IsRegular() {
						logical := path
						if rel != "." {
							logical = filepath.Join(resolved, strings.Split(rel, string(os.PathSeparator))[0])
						}
						add(filepath.Base(logical), path, "")
						return filepath.SkipDir
					}
				}
			}

			return nil
		})
		if e != nil {
			s.DiscoveryComplete = false
			s.Errors = append(s.Errors, "discovery root inaccessible")
		}
	}
	appendProjects := func() {
		retained := map[string]bool{}
		for _, p := range inventory.Projects {
			retained[p.Key] = true
		}
		for _, c := range s.Containers {
			retained[c.ProjectKey] = true
		}
		for _, p := range projects {
			if retained[p.Key] {
				s.Projects = append(s.Projects, p)
			}
		}
	}
	var v struct {
		APIVersion string `json:"ApiVersion"`
	}
	if e := a.dockerGet(ctx, "/version", &v); e != nil {
		s.Errors = append(s.Errors, "Docker unavailable")
		appendProjects()
		return s
	}
	a.apiVersion = "/v" + v.APIVersion
	var list []struct {
		ID    string `json:"Id"`
		Names []string
	}
	if e := a.dockerGet(ctx, a.apiVersion+"/containers/json?all=1", &list); e != nil {
		s.Errors = append(s.Errors, "Docker listing failed")
		appendProjects()
		return s
	}
	s.DockerComplete = true
	names := map[string]bool{}
	for _, item := range list {
		for _, name := range item.Names {
			names[strings.TrimPrefix(name, "/")] = true
		}
	}
	inspected := []dockerContainer{}
	for _, item := range list {
		var d dockerContainer
		if e := a.dockerGet(ctx, a.apiVersion+"/containers/"+url.PathEscape(item.ID)+"/json", &d); e != nil {
			s.DockerComplete = false
			s.Errors = append(s.Errors, "container inspection failed")
			continue
		}
		inspected = append(inspected, d)
	}
	locations := inventory
	locations.Projects = nil
	for _, p := range projects {
		locations.Projects = append(locations.Projects, p)
	}
	resolved := map[string]Project{}
	groups := map[string]Project{}
	ambiguousGroups := map[string]bool{}
	for _, d := range inspected {
		rawName := strings.TrimPrefix(d.Name, "/")
		name, include := inventoryContainerName(rawName, d.ID, d.Config.Labels)
		if !include || (name != rawName && names[name]) {
			continue
		}
		p, ok := a.containerLocation(name, d, locations)
		if !ok {
			continue
		}
		resolved[d.ID] = p
		group := d.Config.Labels["com.docker.compose.project"]
		if group == "" {
			continue
		}
		if prior, found := groups[group]; found && !sameProjectPath(prior.Path, p.Path) {
			ambiguousGroups[group] = true
		}
		groups[group] = p
	}
	for _, d := range inspected {
		rawName := strings.TrimPrefix(d.Name, "/")
		labels := d.Config.Labels
		name, include := inventoryContainerName(rawName, d.ID, labels)
		if !include || (name != rawName && names[name]) {
			continue
		}
		path := ""
		pn := labels["com.docker.compose.project"]
		registered, ok := resolved[d.ID]
		if !ok && pn != "" && !ambiguousGroups[pn] {
			registered, ok = groups[pn]
		}
		if ok {
			path = registered.Path
			pn = registered.Name
		}

		key := "unassigned"
		if pn != "" {
			key = "compose:" + pn
		}
		if registered.Key != "" {
			key = registered.Key
		}
		key = add(pn, path, key)
		c := Container{Name: name, ProjectKey: key, Image: d.Config.Image, ImageID: d.Image, ID: d.ID, State: d.State.Status, Health: "none", Restarts: d.RestartCount, Started: d.State.StartedAt, Finished: d.State.FinishedAt, ExitCode: d.State.ExitCode}
		if d.State.Health != nil {
			c.Health = d.State.Health.Status
		}

		s.Containers = append(s.Containers, c)
	}
	if metrics {
		var wg sync.WaitGroup
		slots := make(chan struct{}, 8)
		failures := make(chan string, len(s.Containers))
		for i := range s.Containers {
			if s.Containers[i].State != "running" {
				continue
			}
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				break
			}
			if ctx.Err() != nil {
				break
			}
			wg.Add(1)
			go func(c *Container) {
				defer wg.Done()
				defer func() { <-slots }()
				if err := a.containerMetrics(ctx, c); err != nil {
					failures <- err.Error()
				}
			}(&s.Containers[i])
		}
		wg.Wait()
		close(failures)
		for failure := range failures {
			s.Errors = append(s.Errors, failure)
		}
	}

	appendProjects()
	sort.Slice(s.Projects, func(i, j int) bool { return s.Projects[i].Key < s.Projects[j].Key })
	return s
}
func (a *Agent) containerMetrics(ctx context.Context, c *Container) error {

	type cpu struct {
		CPUUsage struct {
			Total  uint64   `json:"total_usage"`
			PerCPU []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		System uint64 `json:"system_cpu_usage"`
		Online uint64 `json:"online_cpus"`
	}
	var st struct {
		CPU    cpu `json:"cpu_stats"`
		Pre    cpu `json:"precpu_stats"`
		Memory struct {
			Usage uint64            `json:"usage"`
			Limit uint64            `json:"limit"`
			Stats map[string]uint64 `json:"stats"`
		} `json:"memory_stats"`
	}
	if e := a.dockerGet(ctx, a.apiVersion+"/containers/"+url.PathEscape(c.ID)+"/stats?stream=false", &st); e == nil {
		n := st.CPU.Online
		if n == 0 {
			n = uint64(len(st.CPU.CPUUsage.PerCPU))
		}
		if st.CPU.System > st.Pre.System && st.CPU.CPUUsage.Total >= st.Pre.CPUUsage.Total && n > 0 {
			x := float64(st.CPU.CPUUsage.Total-st.Pre.CPUUsage.Total) / float64(st.CPU.System-st.Pre.System) * float64(n) * 100
			c.CPU = &x
		}
		usage := st.Memory.Usage
		cache := st.Memory.Stats["total_inactive_file"]
		if cache == 0 {
			cache = st.Memory.Stats["inactive_file"]
		}
		if cache < usage {
			usage -= cache
		}
		c.Memory = &usage
		c.MemoryLimit = &st.Memory.Limit
	} else {
		return errors.New("container metrics unavailable: " + c.Name)
	}
	return nil
}

func (a *Agent) enqueue(s Snapshot) error {
	if e := os.MkdirAll(a.cfg.StateDir, 0700); e != nil {
		return e
	}
	data, e := json.Marshal(s)
	if e != nil {
		return e
	}
	if len(data) > 4<<20 {
		return errors.New("snapshot exceeds 4 MiB")
	}
	name := filepath.Join(a.cfg.StateDir, fmt.Sprintf("%020d-%s.json", time.Now().UnixNano(), s.SampleID))
	if e = os.WriteFile(name+".tmp", data, 0600); e != nil {
		return e
	}
	return os.Rename(name+".tmp", name)
}
func (a *Agent) flush(ctx context.Context) error {
	files, e := filepath.Glob(filepath.Join(a.cfg.StateDir, "*.json"))
	if e != nil {
		return e
	}
	sort.Strings(files)
	for i, f := range files {
		info, e := os.Stat(f)
		if e != nil {
			continue
		}
		if time.Since(info.ModTime()) > 24*time.Hour || i < len(files)-288 {
			if e = os.Remove(f); e != nil {
				return e
			}
			continue
		}
		b, e := os.ReadFile(f)
		if e != nil {
			return e
		}
		if e = a.apiCall(ctx, "POST", "/api/i7y/telemetry/v1/snapshots", b, nil); e != nil {
			return e
		}
		if e = os.Remove(f); e != nil {
			return e
		}
	}
	return nil
}
func main() {
	config := flag.String("config", "/etc/i7y-agent/config.json", "Configuration file")
	once := flag.Bool("once", false, "Collect and send once")
	diagnose := flag.Bool("diagnose", false, "Check API and Docker without sending")
	showVersion := flag.Bool("version", false, "Print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	st, e := os.Stat(*config)
	if e != nil {
		log.Fatal("configuration unavailable")
	}
	if st.Mode().Perm()&0077 != 0 {
		log.Fatal("configuration must have mode 0600")
	}
	data, e := os.ReadFile(*config)
	if e != nil {
		log.Fatal("configuration unreadable")
	}
	var c Config
	if json.Unmarshal(data, &c) != nil {
		log.Fatal("invalid configuration")
	}
	u, e := url.Parse(c.URL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		log.Fatal("HTTPS API URL required")
	}
	if !strings.HasPrefix(c.Token, "i7ya_") {
		log.Fatal("agent credential required")
	}
	if c.Mode != "" && c.Mode != "docker" && c.Mode != "host" {
		log.Fatal("invalid collection mode")
	}
	a := newAgent(c)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *diagnose {
		var out Inventory
		if a.apiCall(ctx, "GET", "/api/i7y/telemetry/v1/config", nil, &out) != nil {
			log.Fatal("API diagnostic failed")
		}
		var v any
		if a.cfg.Mode != "host" && a.dockerGet(ctx, "/version", &v) != nil {
			log.Fatal("Docker diagnostic failed")
		}
		log.Print("collection mode available: ", a.cfg.Mode)
		return
	}
	if e := os.MkdirAll(a.cfg.StateDir, 0700); e != nil {
		log.Fatal("state directory unavailable")
	}
	lock, e := os.OpenFile(filepath.Join(a.cfg.StateDir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		log.Fatal("lock unavailable")
	}
	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		log.Fatal("another agent is running")
	}
	events := make(chan struct{}, 1)
	if !*once && a.cfg.Mode != "host" {
		go a.watchDockerEvents(ctx, events)
	}
	var eventDue time.Time
	nextCollect := time.Now()
	nextSend := time.Now()
	backoff := 10 * time.Second
	retrying := false
	for ctx.Err() == nil {
		if !time.Now().Before(nextCollect) {
			cycle, cancel := context.WithTimeout(ctx, 4*time.Minute)
			s := a.collect(cycle)
			cancel()
			if ctx.Err() != nil {
				return
			}
			if a.enqueue(s) != nil {
				log.Print("snapshot persistence failed")
			} else {
				log.Printf("collected %d containers; errors=%d", len(s.Containers), len(s.Errors))
			}
			if !retrying {
				nextSend = time.Now()
			}
			nextCollect = nextCollect.Add(300 * time.Second)
			if nextCollect.Before(time.Now()) {
				nextCollect = time.Now().Add(300 * time.Second)
			}
		}
		if !eventDue.IsZero() && !time.Now().Before(eventDue) {
			cycle, cancel := context.WithTimeout(ctx, 45*time.Second)
			s := a.collectWithMetrics(cycle, false)
			cancel()
			if ctx.Err() != nil {
				return
			}
			if a.enqueue(s) != nil {
				log.Print("event snapshot persistence failed")
			} else {
				log.Printf("event reconciliation: %d containers; errors=%d", len(s.Containers), len(s.Errors))
			}
			eventDue = time.Time{}
			if !retrying {
				nextSend = time.Now()
			}
		}

		if !time.Now().Before(nextSend) || *once {
			sendCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
			e := a.flush(sendCtx)
			cancel()
			if e != nil {
				retrying = true
				log.Printf("send failed: %v", e)
				nextSend = time.Now().Add(backoff)
				backoff *= 2
				if backoff > 5*time.Minute {
					backoff = 5 * time.Minute
				}
				if *once {
					os.Exit(1)
				}
			} else {
				retrying = false
				backoff = 10 * time.Second
				nextSend = time.Now().Add(300 * time.Second)
				log.Print("queue delivered")
			}
		}
		if *once {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-events:
			if eventDue.IsZero() {
				eventDue = time.Now().Add(2 * time.Second)
			}
		case <-time.After(time.Second):
		}
	}
}
func readNumbers(path string) []float64 {
	b, _ := os.ReadFile(path)
	var out []float64
	for _, v := range strings.Fields(string(b)) {
		n, e := strconv.ParseFloat(v, 64)
		if e == nil {
			out = append(out, n)
		}
	}
	return out
}
