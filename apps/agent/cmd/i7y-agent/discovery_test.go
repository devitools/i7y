package main

import "testing"

func TestComposeTemporaryNamesPreserveServiceIdentity(t *testing.T) {
	labels := map[string]string{"com.docker.compose.project": "example", "com.docker.compose.service": "web"}
	name, ok := inventoryContainerName("abcdef012345_web", "abcdef0123456789", labels)
	if !ok || name != "web" {
		t.Fatal("temporary Compose name not normalized", name)
	}
	for _, test := range []struct {
		name, id string
		labels   map[string]string
	}{
		{"abcdef012345_web", "abcdef0123456789", nil},
		{"abcdef012345_web", "different-id", labels},
		{"custom_hash_web", "abcdef0123456789", labels},
	} {
		name, ok = inventoryContainerName(test.name, test.id, test.labels)
		if !ok || name != test.name {
			t.Fatal("legitimate name changed", test.name, name)
		}
	}
	for _, key := range []string{"com.docker.compose.oneoff", "i7y.ignore"} {
		if _, ok = inventoryContainerName("job", "abcdef0123456789", map[string]string{key: "True"}); ok {
			t.Fatal("explicit temporary container accepted", key)
		}
	}
	if _, ok = inventoryContainerName("web", "abcdef0123456789", map[string]string{"com.docker.compose.oneoff": "False"}); !ok {
		t.Fatal("regular Compose service excluded")
	}
}
