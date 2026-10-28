package main

import "strings"

func inventoryContainerName(name, id string, labels map[string]string) (string, bool) {
	if strings.EqualFold(strings.TrimSpace(labels["i7y.ignore"]), "true") || strings.EqualFold(strings.TrimSpace(labels["com.docker.compose.oneoff"]), "true") {
		return "", false
	}
	if len(id) >= 12 && labels["com.docker.compose.project"] != "" && labels["com.docker.compose.service"] != "" {
		prefix := id[:12] + "_"
		if strings.HasPrefix(name, prefix) && len(name) > len(prefix) {
			return strings.TrimPrefix(name, prefix), true
		}
	}
	return name, true
}
