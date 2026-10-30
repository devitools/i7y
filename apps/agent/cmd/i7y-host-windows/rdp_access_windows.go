package main

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func lastRDPAccess() *string {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	query := `$ErrorActionPreference='Stop'; $filter="*[System[(EventID=21 or EventID=25)]] and *[UserData[EventXML[Address!='LOCAL' and Address!='' and Address!='127.0.0.1' and Address!='::1']]]"; $event=Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -FilterXPath $filter -MaxEvents 1 -ErrorAction Stop; $event.TimeCreated.ToUniversalTime().ToString('o')`
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query)
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	value := strings.TrimSpace(string(output))
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.After(time.Now().Add(time.Minute)) {
		return nil
	}
	value = parsed.UTC().Format(time.RFC3339)
	return &value
}
