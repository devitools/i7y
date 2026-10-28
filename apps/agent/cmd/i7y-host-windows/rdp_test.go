package main

import (
	"errors"
	"testing"
)

func TestActiveRDP(t *testing.T) {
	cases := []struct {
		name   string
		states []uint32
		kinds  []uint16
		fail   map[int]bool
		want   string
	}{
		{"empty", nil, nil, nil, "false"},
		{"console", []uint32{0}, []uint16{0}, nil, "false"},
		{"disconnected RDP", []uint32{4}, []uint16{2}, nil, "false"},
		{"active RDP", []uint32{0}, []uint16{2}, nil, "true"},
		{"unreadable active session", []uint32{0}, []uint16{0}, map[int]bool{0: true}, "unknown"},
		{"known active despite another failure", []uint32{0, 0}, []uint16{0, 2}, map[int]bool{0: true}, "true"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := activeRDP(c.states, func(i int) (uint16, error) {
				if c.states[i] != 0 {
					t.Fatal("queried a disconnected session")
				}
				if c.fail[i] {
					return 0, errors.New("access denied")
				}
				return c.kinds[i], nil
			})
			value := "unknown"
			if got != nil {
				value = "false"
				if *got {
					value = "true"
				}
			}
			if value != c.want {
				t.Fatalf("got %s, want %s", value, c.want)
			}
		})
	}
}
