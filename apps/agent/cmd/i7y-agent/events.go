package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func relevantDockerEvent(action string) bool {
	switch action {
	case "create", "start", "stop", "die", "destroy", "pause", "unpause", "restart", "rename":
		return true
	}
	return strings.HasPrefix(action, "health_status:")
}

func signalReconciliation(ch chan<- struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (a *Agent) dockerEvents(ctx context.Context, changes chan<- struct{}, since *int64) error {
	var v struct {
		APIVersion string `json:"ApiVersion"`
	}
	if err := a.dockerGet(ctx, "/version", &v); err != nil {
		return err
	}
	query := url.Values{"filters": {`{"type":["container"]}`}}
	if *since > 0 {
		query.Set("since", fmt.Sprint(*since))
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "http://docker/v"+v.APIVersion+"/events?"+query.Encode(), nil)
	if err != nil {
		return err
	}
	client := http.Client{Transport: a.docker.Transport}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("Docker events HTTP %d", res.StatusCode)
	}
	signalReconciliation(changes)
	decoder := json.NewDecoder(res.Body)
	for {
		var event struct {
			Type   string
			Action string
			Status string `json:"status"`
			Time   int64  `json:"time"`
		}
		if err := decoder.Decode(&event); err != nil {
			return err
		}
		if event.Time > *since {
			*since = event.Time
		}
		action := event.Action
		if action == "" {
			action = event.Status
		}
		if (event.Type == "container" || event.Type == "") && relevantDockerEvent(action) {
			signalReconciliation(changes)
		}
	}
}

func (a *Agent) watchDockerEvents(ctx context.Context, changes chan<- struct{}) {
	var since int64
	for ctx.Err() == nil {
		err := a.dockerEvents(ctx, changes, &since)
		if ctx.Err() != nil {
			return
		}
		log.Printf("Docker event stream interrupted; reconnecting: %v", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
