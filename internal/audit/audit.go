package audit

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type Logger struct {
	path string
	mu   sync.Mutex
}
type Entry struct {
	Time    time.Time         `json:"time"`
	User    string            `json:"user"`
	Action  string            `json:"action"`
	IP      string            `json:"ip,omitempty"`
	Details map[string]string `json:"details,omitempty"`
}

func New(path string) *Logger { return &Logger{path: path} }
func (l *Logger) Log(user, action, ip string, details map[string]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_ = json.NewEncoder(f).Encode(Entry{Time: time.Now().UTC(), User: user, Action: action, IP: ip, Details: details})
}
func (l *Logger) Path() string { return l.path }
