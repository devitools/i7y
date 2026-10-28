package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

type windowsVersion struct {
	Size, Major, Minor, Build, Platform uint32
	ServicePack                         [128]uint16
}

func registryVersionValue(name string) string {
	path, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`)
	var key syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, path, 0, syscall.KEY_READ|syscall.KEY_WOW64_64KEY, &key) != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	field, _ := syscall.UTF16PtrFromString(name)
	var kind, size uint32
	if syscall.RegQueryValueEx(key, field, nil, &kind, nil, &size) != nil || size > 4096 || size == 0 {
		return ""
	}
	data := make([]byte, size)
	if syscall.RegQueryValueEx(key, field, nil, &kind, &data[0], &size) != nil {
		return ""
	}
	if kind == syscall.REG_DWORD && size == 4 {
		return fmt.Sprint(binary.LittleEndian.Uint32(data))
	}
	if kind != syscall.REG_SZ {
		return ""
	}
	chars := make([]uint16, len(data)/2)
	for i := range chars {
		chars[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	return syscall.UTF16ToString(chars)
}
func operatingSystemInfo() map[string]any {
	v := windowsVersion{}
	v.Size = uint32(unsafe.Sizeof(v))
	status, _, _ := syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion").Call(uintptr(unsafe.Pointer(&v)))
	kernel, versionID := "", ""
	if status == 0 {
		kernel = fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Build)
		versionID = kernel
	}
	if revision := registryVersionValue("UBR"); revision != "" && kernel != "" {
		kernel += "." + revision
	}
	name := registryVersionValue("ProductName")
	if name == "" {
		name = "Windows"
	}
	if v.Build >= 22000 && strings.HasPrefix(name, "Windows 10") {
		name = strings.Replace(name, "Windows 10", "Windows 11", 1)
	}
	release := registryVersionValue("DisplayVersion")
	if release == "" {
		release = registryVersionValue("ReleaseId")
	}
	return map[string]any{"family": "windows", "name": name, "pretty_name": name, "id": "windows", "version": release, "version_id": versionID, "kernel": kernel, "architecture": runtime.GOARCH}
}
