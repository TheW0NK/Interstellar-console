package config

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type Config struct {
	BindAddress string       `json:"bindAddress"`
	Port        int          `json:"port"`
	ContentRoot string       `json:"contentRoot"`
	ConsoleHTML string       `json:"consoleHtml"`
	Server      ServerConfig `json:"server"`
	RCON        RCONConfig   `json:"rcon"`
	Backups     BackupConfig `json:"backups"`
	Users       []User       `json:"users"`
}

type ServerConfig struct {
	Jar            string   `json:"jar"`
	JavaPath       string   `json:"javaPath"`
	JavaArgs       []string `json:"javaArgs"`
	AutoAcceptEULA bool     `json:"autoAcceptEula"`
}

type RCONConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Password string `json:"password"`
}
type BackupConfig struct {
	Directory string   `json:"directory"`
	Include   []string `json:"include"`
	Exclude   []string `json:"exclude"`
}
type User struct {
	Username     string `json:"username"`
	Role         string `json:"role"`
	Salt         string `json:"salt"`
	PasswordHash string `json:"passwordHash"`
}

func LoadOrCreate(path string) (*Config, bool, error) {
	if b, err := os.ReadFile(path); err == nil {
		var c Config
		if err := json.Unmarshal(b, &c); err != nil {
			return nil, false, err
		}
		if err := c.Normalize(filepath.Dir(path)); err != nil {
			return nil, false, err
		}
		return &c, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}

	pwd := randText(18)
	salt := randText(16)
	hash := HashPassword(pwd, salt)
	c := &Config{
		BindAddress: "0.0.0.0", Port: 36688, ContentRoot: ".", ConsoleHTML: "console.html",
		Server:  ServerConfig{Jar: "server.jar", JavaPath: "java", JavaArgs: []string{"-jar", "server.jar", "nogui"}, AutoAcceptEULA: true},
		RCON:    RCONConfig{Host: "127.0.0.1", Port: 25575, Password: randText(24)},
		Backups: BackupConfig{Directory: "backups", Include: []string{"world", "world_nether", "world_the_end", "plugins", "server.properties", "paper-global.yml", "spigot.yml"}, Exclude: []string{"backups", "logs/cache"}},
		Users:   []User{{Username: "Adrian_", Role: "owner", Salt: salt, PasswordHash: hash}},
	}
	if err := c.Normalize(filepath.Dir(path)); err != nil {
		return nil, true, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil && filepath.Dir(path) != "." {
		return nil, true, err
	}
	if err := c.Save(path); err != nil {
		return nil, true, err
	}
	fmt.Printf("Generated config at %s\nInitial owner login: Adrian_ / %s\n", path, pwd)
	return c, true, nil
}

func (c *Config) Normalize(base string) error {
	if c.ContentRoot == "" {
		c.ContentRoot = "."
	}
	root, err := filepath.Abs(filepath.Join(base, c.ContentRoot))
	if err != nil {
		return err
	}
	c.ContentRoot = root
	if c.Port == 0 {
		c.Port = 36688
	}
	if c.BindAddress == "" {
		c.BindAddress = "0.0.0.0"
	}
	if c.Server.Jar == "" {
		c.Server.Jar = "server.jar"
	}
	if c.Server.JavaPath == "" {
		c.Server.JavaPath = "java"
	}
	if len(c.Server.JavaArgs) == 0 {
		c.Server.JavaArgs = []string{"-jar", c.Server.Jar, "nogui"}
	}
	if c.RCON.Host == "" {
		c.RCON.Host = "127.0.0.1"
	}
	if c.RCON.Port == 0 {
		c.RCON.Port = 25575
	}
	if c.Backups.Directory == "" {
		c.Backups.Directory = "backups"
	}
	return nil
}
func (c *Config) Save(path string) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(path, b, 0600)
}
func (c *Config) Addr() string { return fmt.Sprintf("%s:%d", c.BindAddress, c.Port) }
func HashPassword(pass, salt string) string {
	h := sha256.Sum256([]byte(salt + ":" + pass))
	return hex.EncodeToString(h[:])
}
func randText(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}
