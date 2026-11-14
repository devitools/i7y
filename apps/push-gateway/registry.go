package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type AppProfile struct {
	Platform         string      `json:"platform"`
	AppID            string      `json:"app_id"`
	Environment      string      `json:"environment"`
	AndroidChannelID string      `json:"android_channel_id,omitempty"`
	APNS             *APNSConfig `json:"apns,omitempty"`
	FCM              *FCMConfig  `json:"fcm,omitempty"`
}

type APNSConfig struct {
	PrivateKeyFile string `json:"private_key_file"`
	KeyID          string `json:"key_id"`
	TeamID         string `json:"team_id"`
}

type FCMConfig struct {
	ServiceAccountFile string `json:"service_account_file"`
}

type ProviderRegistry struct {
	profiles map[string]Provider
}

func profileKey(platform, app, environment string) string {
	return platform + ":" + app + ":" + environment
}

func validProfile(platform, app, environment string) bool {
	return (platform == "ios" || platform == "android") && (environment == "sandbox" || environment == "production") && cleanString(app, 255) && !strings.Contains(app, ":")
}

func (p *ProviderRegistry) Send(ctx context.Context, d Destination, n Notification) ProviderResult {
	provider := p.profiles[profileKey(d.Platform, d.AppID, d.Environment)]
	if provider == nil {
		return ProviderResult{Code: "provider_unconfigured"}
	}
	return provider.Send(ctx, d, n)
}

func NewConfiguredProviderFromEnv() (Provider, map[string]bool, error) {
	if path := os.Getenv("GATEWAY_CONFIG_FILE"); path != "" {
		return NewProviderRegistry(path)
	}
	p, err := NewNativeProviderFromEnv()
	if err != nil {
		return nil, nil, err
	}
	allowed := map[string]bool{}
	for _, value := range strings.Split(os.Getenv("GATEWAY_ALLOWED_APPS"), ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		parts := strings.Split(value, ":")
		if len(parts) != 3 || !validProfile(parts[0], parts[1], parts[2]) {
			return nil, nil, errors.New("invalid app allowlist")
		}
		if parts[0] == "ios" && p.APNSKey == nil && (parts[2] != "production" || p.productionAPNS == nil) || parts[0] == "android" && p.FCMKey == nil {
			return nil, nil, errors.New("allowlisted platform has no provider credentials")
		}
		allowed[value] = true
	}
	if len(allowed) == 0 {
		return nil, nil, errors.New("GATEWAY_ALLOWED_APPS is required without GATEWAY_CONFIG_FILE")
	}
	return p, allowed, nil
}

func NewProviderRegistry(path string) (*ProviderRegistry, map[string]bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, errors.New("cannot read gateway configuration")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, nil, errors.New("invalid gateway configuration size")
	}
	var config struct {
		Profiles []AppProfile `json:"profiles"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF || len(config.Profiles) == 0 || len(config.Profiles) > 256 {
		return nil, nil, errors.New("invalid gateway configuration")
	}
	registry := &ProviderRegistry{profiles: map[string]Provider{}}
	allowed := map[string]bool{}
	for _, profile := range config.Profiles {
		key := profileKey(profile.Platform, profile.AppID, profile.Environment)
		if !validProfile(profile.Platform, profile.AppID, profile.Environment) || allowed[key] {
			return nil, nil, errors.New("invalid or duplicate application profile")
		}
		p := newNativeProvider()
		if profile.Platform == "ios" {
			if profile.APNS == nil || profile.FCM != nil || profile.AndroidChannelID != "" || profile.APNS.PrivateKeyFile == "" || !cleanString(profile.APNS.KeyID, 128) || !cleanString(profile.APNS.TeamID, 128) {
				return nil, nil, errors.New("invalid APNs profile")
			}
			if err = loadAPNSFile(p, configPath(path, profile.APNS.PrivateKeyFile), profile.APNS.KeyID, profile.APNS.TeamID); err != nil {
				return nil, nil, err
			}
		} else {
			if profile.FCM == nil || profile.APNS != nil || profile.FCM.ServiceAccountFile == "" || !identifier.MatchString(profile.AndroidChannelID) {
				return nil, nil, errors.New("invalid FCM profile")
			}
			if err = loadFCMAccount(p, configPath(path, profile.FCM.ServiceAccountFile)); err != nil {
				return nil, nil, err
			}
			p.AndroidChannel = profile.AndroidChannelID
		}
		registry.profiles[key] = p
		allowed[key] = true
	}
	return registry, allowed, nil
}

func configPath(config, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(filepath.Dir(config), path)
}

func loadAPNSFile(p *NativeProvider, path, keyID, teamID string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return errors.New("cannot read APNs signing key")
	}
	key, err := parseKey(raw)
	if err != nil {
		return errors.New("invalid APNs signing key")
	}
	var ok bool
	p.APNSKey, ok = key.(*ecdsa.PrivateKey)
	if !ok || p.APNSKey.Curve != elliptic.P256() {
		return errors.New("APNs requires a P-256 key")
	}
	p.APNSKeyID, p.APNSTeamID = keyID, teamID
	return nil
}

func loadFCMAccount(p *NativeProvider, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return errors.New("cannot read FCM service account")
	}
	var account serviceAccount
	if json.Unmarshal(raw, &account) != nil || account.Type != "service_account" || !cleanString(account.ProjectID, 255) || !cleanString(account.ClientEmail, 255) {
		return errors.New("invalid FCM service account")
	}
	key, err := parseKey([]byte(account.PrivateKey))
	if err != nil {
		return errors.New("invalid FCM signing key")
	}
	var ok bool
	p.FCMKey, ok = key.(*rsa.PrivateKey)
	if !ok || p.FCMKey.N.BitLen() < 2048 {
		return errors.New("FCM requires RSA 2048 or stronger")
	}
	p.FCMEmail, p.FCMProject = account.ClientEmail, account.ProjectID
	p.fcmURL = "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(account.ProjectID) + "/messages:send"
	return nil
}
