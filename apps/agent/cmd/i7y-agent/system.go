package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
)

func parseOSRelease(data string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "NAME", "PRETTY_NAME", "VERSION", "VERSION_ID", "ID":
		default:
			continue
		}
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			if decoded, err := strconv.Unquote(value); err == nil {
				value = decoded
			}
		} else if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = value[1 : len(value)-1]
		}
		out[key] = value
	}
	return out
}
func operatingSystemInfo() map[string]any {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		data, _ = os.ReadFile("/usr/lib/os-release")
	}
	fields := parseOSRelease(string(data))
	name := fields["NAME"]
	if name == "" {
		name = runtime.GOOS
	}
	kernel, _ := os.ReadFile("/proc/sys/kernel/osrelease")
	return map[string]any{"family": runtime.GOOS, "name": name, "pretty_name": fields["PRETTY_NAME"], "id": fields["ID"], "version": fields["VERSION"], "version_id": fields["VERSION_ID"], "kernel": strings.TrimSpace(string(kernel)), "architecture": runtime.GOARCH}
}
