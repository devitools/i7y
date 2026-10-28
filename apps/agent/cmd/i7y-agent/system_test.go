package main

import "testing"

func TestOSReleaseIsReadAsData(t *testing.T) {
	data := "NAME=\"CentOS Linux\"\nPRETTY_NAME='CentOS Linux 7 (Core)'\nVERSION_ID=7\nID=centos\nUNRELATED=private\n# comment\n"
	got := parseOSRelease(data)
	if got["NAME"] != "CentOS Linux" || got["PRETTY_NAME"] != "CentOS Linux 7 (Core)" || got["VERSION_ID"] != "7" || got["ID"] != "centos" {
		t.Fatalf("unexpected OS metadata: %+v", got)
	}
	if _, ok := got["UNRELATED"]; ok {
		t.Fatal("unrelated release data collected")
	}
	got = parseOSRelease("NAME=\"$(touch /tmp/not-executed)\"\nVERSION=\"v1\\\"test\"\n")
	if got["NAME"] != "$(touch /tmp/not-executed)" || got["VERSION"] != "v1\"test" {
		t.Fatalf("release content transformed incorrectly: %+v", got)
	}
	info := operatingSystemInfo()
	if info["family"] == "" || info["architecture"] == "" || info["name"] == "" {
		t.Fatal("platform identity missing")
	}
}
