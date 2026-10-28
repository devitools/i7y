package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var version = "dev"
var kernel = syscall.NewLazyDLL("kernel32.dll")
var systemTimes = kernel.NewProc("GetSystemTimes")
var memoryStatus = kernel.NewProc("GlobalMemoryStatusEx")
var driveStrings = kernel.NewProc("GetLogicalDriveStringsW")
var driveType = kernel.NewProc("GetDriveTypeW")
var diskSpace = kernel.NewProc("GetDiskFreeSpaceExW")
var tickCount = kernel.NewProc("GetTickCount64")

type config struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	StateDir string `json:"state_dir"`
	Mode     string `json:"mode"`
}
type memoryInfo struct {
	Length, Load                                                                         uint32
	Total, Available, TotalPage, AvailablePage, TotalVirtual, AvailableVirtual, Extended uint64
}

func ticks(t syscall.Filetime) uint64 { return uint64(t.HighDateTime)<<32 | uint64(t.LowDateTime) }
func cpuTimes() (uint64, uint64, bool) {
	var idle, kernel, user syscall.Filetime
	ok, _, _ := systemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user)))
	return ticks(idle), ticks(kernel) + ticks(user), ok != 0
}
func collect() map[string]any {
	host := map[string]any{"os": "windows", "operating_system": operatingSystemInfo(), "cpu_percent": nil, "memory_total_bytes": nil, "memory_available_bytes": nil, "uptime_seconds": nil, "load": nil, "disks": []any{}, "rdp_session_active": rdpSessionActive()}
	notices := []string{}
	idle, total, ok := cpuTimes()
	time.Sleep(time.Second)
	nextIdle, nextTotal, nextOK := cpuTimes()
	if ok && nextOK && nextTotal > total {
		host["cpu_percent"] = 100 * (1 - float64(nextIdle-idle)/float64(nextTotal-total))
	} else {
		notices = append(notices, "host CPU unavailable")
	}
	mem := memoryInfo{}
	mem.Length = uint32(unsafe.Sizeof(mem))
	if result, _, _ := memoryStatus.Call(uintptr(unsafe.Pointer(&mem))); result != 0 {
		host["memory_total_bytes"] = mem.Total
		host["memory_available_bytes"] = mem.Available
	} else {
		notices = append(notices, "host memory unavailable")
	}
	uptime, _, _ := tickCount.Call()
	host["uptime_seconds"] = float64(uptime) / 1000
	buffer := make([]uint16, 512)
	length, _, _ := driveStrings.Call(uintptr(len(buffer)), uintptr(unsafe.Pointer(&buffer[0])))
	disks := []any{}
	if length == 0 || length >= uintptr(len(buffer)) {
		notices = append(notices, "host filesystems unavailable")
	} else {
		start := 0
		for i := 0; i < int(length); i++ {
			if buffer[i] != 0 {
				continue
			}
			if i == start {
				break
			}
			path := syscall.UTF16ToString(buffer[start:i])
			start = i + 1
			ptr, _ := syscall.UTF16PtrFromString(path)
			kind, _, _ := driveType.Call(uintptr(unsafe.Pointer(ptr)))
			if kind != 3 {
				continue
			}
			var available, total uint64
			result, _, _ := diskSpace.Call(uintptr(unsafe.Pointer(ptr)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), 0)
			if result == 0 {
				notices = append(notices, "filesystem metrics unavailable: "+path)
				continue
			}
			disks = append(disks, map[string]any{"path": path, "total_bytes": total, "available_bytes": available})
		}
	}
	host["disks"] = disks
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		log.Fatal("sample identifier unavailable")
	}
	return map[string]any{"version": 1, "sample_id": hex.EncodeToString(id), "observed_at": time.Now().UTC().Format(time.RFC3339Nano), "agent_version": version, "collection_mode": "host", "metrics_complete": true, "reason": "periodic", "host": host, "docker_complete": false, "discovery_complete": false, "projects": []any{}, "containers": []any{}, "errors": notices}
}
func send(client *http.Client, c config, path string, body []byte) error {
	method := "POST"
	if body == nil {
		method = "GET"
	}
	request, err := http.NewRequest(method, strings.TrimRight(c.URL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid API URL")
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("API connection failed")
	}
	defer response.Body.Close()
	io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("API HTTP %d", response.StatusCode)
	}
	return nil
}
func cycle(client *http.Client, c config) error {
	snapshot := collect()
	body, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	name := filepath.Join(c.StateDir, fmt.Sprintf("%020d-%s.json", time.Now().UnixNano(), snapshot["sample_id"]))
	temp := name + ".tmp"
	if err = os.WriteFile(temp, body, 0600); err != nil {
		return errors.New("snapshot persistence failed")
	}
	if err = os.Rename(temp, name); err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(c.StateDir, "*.json"))
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			return err
		}
		if time.Since(info.ModTime()) > 24*time.Hour {
			if err = os.Remove(file); err != nil {
				return err
			}
			continue
		}
		content, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if err = send(client, c, "/api/i7y/telemetry/v1/snapshots", content); err != nil {
			return err
		}
		if err = os.Remove(file); err != nil {
			return err
		}
	}
	return nil
}
func main() {
	path := flag.String("config", filepath.Join(os.Getenv("ProgramData"), "i7y-agent", "config.json"), "Configuration file")
	once := flag.Bool("once", false, "Collect and deliver one sample")
	diagnose := flag.Bool("diagnose", false, "Validate API access without sending a sample")
	showVersion := flag.Bool("version", false, "Print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	body, err := os.ReadFile(*path)
	if err != nil {
		log.Fatal("configuration unreadable")
	}
	var c config
	if json.Unmarshal(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}), &c) != nil {
		log.Fatal("invalid configuration")
	}
	endpoint, err := url.Parse(c.URL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		log.Fatal("HTTPS API URL required")
	}
	if !strings.HasPrefix(c.Token, "i7ya_") || len(c.Token) != 69 || (c.Mode != "" && c.Mode != "host") {
		log.Fatal("host mode and agent credential required")
	}
	if c.StateDir == "" {
		c.StateDir = filepath.Join(filepath.Dir(*path), "state")
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if *diagnose {
		if err = send(client, c, "/api/i7y/telemetry/v1/config", nil); err != nil {
			log.Fatal(err)
		}
		log.Print("host telemetry API available")
		return
	}
	if err = os.MkdirAll(c.StateDir, 0700); err != nil {
		log.Fatal("state directory unavailable")
	}
	mutexName, _ := syscall.UTF16PtrFromString("Global\\i7y-host-telemetry")
	handle, _, mutexErr := kernel.NewProc("CreateMutexW").Call(0, 1, uintptr(unsafe.Pointer(mutexName)))
	if handle == 0 {
		log.Fatal("collection lock unavailable")
	}
	defer syscall.CloseHandle(syscall.Handle(handle))
	if mutexErr == syscall.Errno(183) {
		log.Fatal("another collector is running")
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	for {
		err = cycle(client, c)
		if err != nil {
			log.Print(err)
		} else {
			log.Print("host telemetry delivered")
		}
		if *once {
			if err != nil {
				os.Exit(1)
			}
			return
		}
		select {
		case <-stop:
			return
		case <-time.After(300 * time.Second):
		}
	}
}
