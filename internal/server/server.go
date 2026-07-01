package server

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"interstellar-console/internal/config"
	"interstellar-console/internal/rcon"
)

type Manager struct {
	cfg         *config.Config
	mu          sync.Mutex
	cmd         *exec.Cmd
	running     bool
	subscribers map[chan string]struct{}
	ring        []string
}

func New(cfg *config.Config) *Manager {
	return &Manager{cfg: cfg, subscribers: map[chan string]struct{}{}}
}
func (m *Manager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return fmt.Errorf("server already running")
	}
	if m.cfg.Server.AutoAcceptEULA {
		_ = os.WriteFile(filepath.Join(m.cfg.ContentRoot, "eula.txt"), []byte("eula=true\n"), 0644)
	}
	if err := m.ensureRCON(); err != nil {
		return err
	}
	cmd := exec.Command(m.cfg.Server.JavaPath, m.cfg.Server.JavaArgs...)
	cmd.Dir = m.cfg.ContentRoot
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	m.cmd = cmd
	m.running = true
	m.publish("[Vexium] server process started")
	go m.scan(stdout)
	go m.scan(stderr)
	go func() {
		err := cmd.Wait()
		m.mu.Lock()
		m.running = false
		m.cmd = nil
		m.mu.Unlock()
		if err != nil {
			m.publish("[Vexium] server process exited: " + err.Error())
		} else {
			m.publish("[Vexium] server process exited")
		}
	}()
	return nil
}
func (m *Manager) Stop() error { _, err := m.RCON().Execute("stop"); return err }
func (m *Manager) Restart() error {
	if err := m.Stop(); err != nil {
		return err
	}
	go func() {
		for i := 0; i < 120; i++ {
			time.Sleep(time.Second)
			m.mu.Lock()
			running := m.running
			m.mu.Unlock()
			if !running {
				_ = m.Start()
				return
			}
		}
		m.publish("[Vexium] restart timed out waiting for stop")
	}()
	return nil
}
func (m *Manager) Command(s string) (string, error) { return m.RCON().Execute(s) }
func (m *Manager) Status() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]any{"running": m.running, "contentRoot": m.cfg.ContentRoot, "jar": m.cfg.Server.Jar}
}
func (m *Manager) RCON() rcon.Client {
	return rcon.Client{Host: m.cfg.RCON.Host, Port: m.cfg.RCON.Port, Password: m.cfg.RCON.Password}
}
func (m *Manager) Subscribe() (chan string, func()) {
	ch := make(chan string, 100)
	m.mu.Lock()
	for _, l := range m.ring {
		ch <- l
	}
	m.subscribers[ch] = struct{}{}
	m.mu.Unlock()
	return ch, func() { m.mu.Lock(); delete(m.subscribers, ch); close(ch); m.mu.Unlock() }
}
func (m *Manager) scan(r io.Reader) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 4096), 1024*1024)
	for s.Scan() {
		m.publish(s.Text())
	}
}
func (m *Manager) publish(line string) {
	m.mu.Lock()
	if len(m.ring) >= 500 {
		copy(m.ring, m.ring[1:])
		m.ring[len(m.ring)-1] = line
	} else {
		m.ring = append(m.ring, line)
	}
	for ch := range m.subscribers {
		select {
		case ch <- line:
		default:
		}
	}
	m.mu.Unlock()
}
func (m *Manager) ensureRCON() error {
	path := filepath.Join(m.cfg.ContentRoot, "server.properties")
	b, _ := os.ReadFile(path)
	props := string(b)
	set := func(k, v string) {
		found := false
		lines := []byte{}
		scanner := bufio.NewScanner(bytesReader(props))
		for scanner.Scan() {
			line := scanner.Text()
			if len(line) > len(k) && line[:len(k)+1] == k+"=" {
				line = k + "=" + v
				found = true
			}
			lines = append(lines, []byte(line+"\n")...)
		}
		if !found {
			lines = append(lines, []byte(k+"="+v+"\n")...)
		}
		props = string(lines)
	}
	set("enable-rcon", "true")
	set("rcon.port", fmt.Sprint(m.cfg.RCON.Port))
	set("rcon.password", m.cfg.RCON.Password)
	return os.WriteFile(path, []byte(props), 0644)
}

type byteReader struct {
	s string
	i int
}

func bytesReader(s string) io.Reader { return &byteReader{s: s} }
func (r *byteReader) Read(p []byte) (int, error) {
	if r.i >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.i:])
	r.i += n
	return n, nil
}
