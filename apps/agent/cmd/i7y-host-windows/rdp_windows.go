package main

import (
	"errors"
	"syscall"
	"unsafe"
)

type wtsSession struct {
	id      uint32
	station *uint16
	state   uint32
}

func rdpSessionActive() *bool {
	wts := syscall.NewLazyDLL("wtsapi32.dll")
	free := wts.NewProc("WTSFreeMemory")
	var data *wtsSession
	var count uint32
	ok, _, _ := wts.NewProc("WTSEnumerateSessionsW").Call(0, 0, 1, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&count)))
	if ok == 0 {
		return nil
	}
	defer free.Call(uintptr(unsafe.Pointer(data)))
	if count > 65536 || (count > 0 && data == nil) {
		return nil
	}
	sessions := unsafe.Slice(data, int(count))
	states := make([]uint32, len(sessions))
	for i, session := range sessions {
		states[i] = session.state
	}
	query := wts.NewProc("WTSQuerySessionInformationW")
	return activeRDP(states, func(i int) (uint16, error) {
		var buffer *uint16
		var size uint32
		ok, _, _ := query.Call(0, uintptr(sessions[i].id), 16, uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&size)))
		if buffer != nil {
			defer free.Call(uintptr(unsafe.Pointer(buffer)))
		}
		if ok == 0 || buffer == nil || size < 2 {
			return 0, errors.New("session protocol unavailable")
		}
		return *buffer, nil
	})
}
