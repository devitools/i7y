package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func hostMetrics(ctx context.Context, errs *[]string) map[string]any {
	out := map[string]any{"operating_system": operatingSystemInfo(), "cpu_percent": nil, "memory_total_bytes": nil, "memory_available_bytes": nil, "uptime_seconds": nil, "load": nil, "disks": []any{}}
	if a := readNumbers("/proc/uptime"); len(a) > 0 {
		out["uptime_seconds"] = a[0]
	} else {
		*errs = append(*errs, "host uptime unavailable")
	}
	if a := readNumbers("/proc/loadavg"); len(a) >= 3 {
		out["load"] = a[:3]
	}
	mem, e := os.ReadFile("/proc/meminfo")
	if e == nil {
		for _, line := range strings.Split(string(mem), "\n") {
			p := strings.Fields(line)
			if len(p) < 2 {
				continue
			}
			n, _ := strconv.ParseUint(p[1], 10, 64)
			switch p[0] {
			case "MemTotal:":
				out["memory_total_bytes"] = n * 1024
			case "MemAvailable:":
				out["memory_available_bytes"] = n * 1024
			}
		}
	} else {
		*errs = append(*errs, "host memory unavailable")
	}
	cpu := func() (float64, float64) {
		b, _ := os.ReadFile("/proc/stat")
		line := strings.SplitN(string(b), "\n", 2)[0]
		var total, idle float64
		for i, v := range strings.Fields(line) {
			if i == 0 || i > 8 {
				continue
			}
			n, _ := strconv.ParseFloat(v, 64)
			total += n
			if i == 4 || i == 5 {
				idle += n
			}
		}
		return total, idle
	}
	t1, i1 := cpu()
	select {
	case <-ctx.Done():
		return out
	case <-time.After(time.Second):
	}
	t2, i2 := cpu()
	if t2 > t1 {
		out["cpu_percent"] = (1 - (i2-i1)/(t2-t1)) * 100
	} else {
		*errs = append(*errs, "host CPU unavailable")
	}
	mounts, e := os.ReadFile("/proc/mounts")
	disks := []any{}
	seen := map[string]bool{}
	if e == nil {
		for _, line := range strings.Split(string(mounts), "\n") {
			p := strings.Fields(line)
			if len(p) < 3 || !strings.HasPrefix(p[0], "/dev/") || seen[p[0]] {
				continue
			}
			seen[p[0]] = true
			path := strings.ReplaceAll(p[1], `\040`, " ")
			var st syscall.Statfs_t
			if syscall.Statfs(path, &st) != nil {
				*errs = append(*errs, "filesystem metrics unavailable")
				continue
			}
			disks = append(disks, map[string]any{"path": path, "total_bytes": uint64(st.Blocks) * uint64(st.Bsize), "available_bytes": uint64(st.Bavail) * uint64(st.Bsize)})
		}
	} else {
		*errs = append(*errs, "host filesystems unavailable")
	}
	out["disks"] = disks
	return out
}
