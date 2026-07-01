package config

import (
	"crypto/hmac"
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
	ProcessMatch   string   `json:"processMatch"`
	LogFile        string   `json:"logFile"`
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
	Algorithm    string `json:"algorithm"`
	Iterations   int    `json:"iterations"`
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
	user := NewUser("Adrian_", "owner", pwd)
	c := &Config{
		BindAddress: "0.0.0.0", Port: 36688, ContentRoot: ".", ConsoleHTML: "console.html",
		Server:  ServerConfig{Jar: "server.jar", JavaPath: "java", JavaArgs: []string{"-jar", "server.jar", "nogui"}, AutoAcceptEULA: true, ProcessMatch: "server.jar", LogFile: "logs/latest.log"},
		RCON:    RCONConfig{Host: "127.0.0.1", Port: 25575, Password: randText(24)},
		Backups: BackupConfig{Directory: "backups", Include: []string{"world", "world_nether", "world_the_end", "plugins", "server.properties", "paper-global.yml", "spigot.yml"}, Exclude: []string{"backups", "logs/cache"}},
		Users:   []User{user},
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
	if c.Server.ProcessMatch == "" {
		c.Server.ProcessMatch = c.Server.Jar
	}
	if c.Server.LogFile == "" {
		c.Server.LogFile = "logs/latest.log"
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

func NewUser(username, role, password string) User {
	salt := randText(32)
	iters := 210_000
	return User{Username: username, Role: role, Salt: salt, Algorithm: "pbkdf2-sha256", Iterations: iters, PasswordHash: PBKDF2Hash(password, salt, iters)}
}

func VerifyPassword(u User, password string) bool {
	algo := u.Algorithm
	if algo == "" {
		algo = "sha256"
	}
	switch algo {
	case "pbkdf2-sha256":
		iters := u.Iterations
		if iters <= 0 {
			iters = 210_000
		}
		return constantEqual(u.PasswordHash, PBKDF2Hash(password, u.Salt, iters))
	case "sha256":
		return constantEqual(u.PasswordHash, LegacyHashPassword(password, u.Salt))
	default:
		return false
	}
}

func LegacyHashPassword(pass, salt string) string {
	h := sha256.Sum256([]byte(salt + ":" + pass))
	return hex.EncodeToString(h[:])
}

func HashPassword(pass, salt string) string { return LegacyHashPassword(pass, salt) }

func PBKDF2Hash(pass, salt string, iterations int) string {
	return hex.EncodeToString(pbkdf2SHA256([]byte(pass), []byte(salt), iterations, 32))
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	hLen := 32
	numBlocks := (keyLen + hLen - 1) / hLen
	var out []byte
	for block := 1; block <= numBlocks; block++ {
		h := hmac.New(sha256.New, password)
		h.Write(salt)
		h.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := h.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iter; i++ {
			h = hmac.New(sha256.New, password)
			h.Write(u)
			u = h.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func constantEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

func randText(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}
