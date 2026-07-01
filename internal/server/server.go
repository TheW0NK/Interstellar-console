package server

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"interstellar-console/internal/config"
	"interstellar-console/internal/rcon"
)

type Manager struct {
	cfg         *config.Config
	mu          sync.Mutex
	cmd         *exec.Cmd
	running     bool
	startedAt   time.Time
	subscribers map[chan string]struct{}
	ring        []string
}

type Status struct {
	State            string  `json:"state"`
	Running          bool    `json:"running"`
	ManagedByConsole bool    `json:"managedByConsole"`
	PID              int     `json:"pid,omitempty"`
	Jar              string  `json:"jar"`
	ContentRoot      string  `json:"contentRoot"`
	StartedAt        string  `json:"startedAt,omitempty"`
	UptimeSeconds    int64   `json:"uptimeSeconds"`
	RCONAvailable    bool    `json:"rconAvailable"`
	PlayersOnline    int     `json:"playersOnline"`
	PlayersMax       int     `json:"playersMax"`
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsedMB     uint64  `json:"memoryUsedMb"`
	MemoryTotalMB    uint64  `json:"memoryTotalMb"`
	DiskUsedGB       float64 `json:"diskUsedGb"`
	DiskTotalGB      float64 `json:"diskTotalGb"`
}

func New(cfg *config.Config) *Manager {
	m := &Manager{cfg: cfg, subscribers: map[chan string]struct{}{}}
	go m.tailLatestLog()
	return m
}
func (m *Manager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return fmt.Errorf("server already running")
	}
	if pid, _ := m.detectProcess(); pid > 0 {
		return fmt.Errorf("server process already running as pid %d", pid)
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
	m.startedAt = time.Now()
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
			if !m.isRunning() {
				_ = m.Start()
				return
			}
		}
		m.publish("[Vexium] restart timed out waiting for stop")
	}()
	return nil
}
func (m *Manager) Command(s string) (string, error) { return m.RCON().Execute(s) }
func (m *Manager) Status() Status {
	m.mu.Lock()
	managed := m.running
	startedAt := m.startedAt
	pid := 0
	if m.cmd != nil && m.cmd.Process != nil {
		pid = m.cmd.Process.Pid
	}
	m.mu.Unlock()
	if pid == 0 {
		pid, _ = m.detectProcess()
	}
	running := managed || pid > 0
	state := "offline"
	if running {
		state = "online"
	}
	status := Status{State: state, Running: running, ManagedByConsole: managed, PID: pid, Jar: m.cfg.Server.Jar, ContentRoot: m.cfg.ContentRoot}
	if !startedAt.IsZero() && managed {
		status.StartedAt = startedAt.UTC().Format(time.RFC3339)
		status.UptimeSeconds = int64(time.Since(startedAt).Seconds())
	} else if running && pid > 0 {
		if ts, ok := processStartTime(pid); ok {
			status.StartedAt = ts.UTC().Format(time.RFC3339)
			status.UptimeSeconds = int64(time.Since(ts).Seconds())
		}
	}
	if running {
		if out, err := m.RCON().Execute("list"); err == nil {
			status.RCONAvailable = true
			status.PlayersOnline, status.PlayersMax = parseList(out)
		}
	}
	status.CPUPercent, status.MemoryUsedMB, status.MemoryTotalMB, status.DiskUsedGB, status.DiskTotalGB = metrics(m.cfg.ContentRoot)
	return status
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
		scanner := bufio.NewScanner(strings.NewReader(props))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, k+"=") {
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
func (m *Manager) isRunning() bool {
	m.mu.Lock()
	managed := m.running
	m.mu.Unlock()
	if managed {
		return true
	}
	pid, _ := m.detectProcess()
	return pid > 0
}
func (m *Manager) detectProcess() (int, string) {
	match := m.cfg.Server.ProcessMatch
	if match == "" {
		match = m.cfg.Server.Jar
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, ""
	}
	self := os.Getpid()
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil || len(b) == 0 {
			continue
		}
		cmdline := strings.ReplaceAll(string(b), "\x00", " ")
		if strings.Contains(cmdline, match) {
			return pid, cmdline
		}
	}
	return 0, ""
}
func (m *Manager) tailLatestLog() {
	path := filepath.Join(m.cfg.ContentRoot, m.cfg.Server.LogFile)
	var offset int64
	for {
		f, err := os.Open(path)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		if info, err := f.Stat(); err == nil && info.Size() < offset {
			offset = 0
		}
		_, _ = f.Seek(offset, io.SeekStart)
		s := bufio.NewScanner(f)
		for s.Scan() {
			line := s.Text()
			offset += int64(len(line) + 1)
			m.mu.Lock()
			managed := m.running
			m.mu.Unlock()
			if !managed {
				m.publish(line)
			}
		}
		if pos, err := f.Seek(0, io.SeekCurrent); err == nil {
			offset = pos
		}
		_ = f.Close()
		time.Sleep(1 * time.Second)
	}
}
func parseList(out string) (int, int) {
	// Vanilla/Paper: "There are 0 of a max of 20 players online:"
	fields := strings.Fields(out)
	for i := 0; i+5 < len(fields); i++ {
		if fields[i] == "are" && fields[i+2] == "of" && fields[i+5] == "players" {
			online, _ := strconv.Atoi(fields[i+1])
			max, _ := strconv.Atoi(fields[i+4])
			return online, max
		}
	}
	return 0, 0
}
func processStartTime(pid int) (time.Time, bool) {
	info, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}
func metrics(root string) (float64, uint64, uint64, float64, float64) {
	used, total := memInfo()
	var st syscall.Statfs_t
	var diskUsed, diskTotal float64
	if syscall.Statfs(root, &st) == nil {
		diskTotal = float64(st.Blocks*uint64(st.Bsize)) / (1024 * 1024 * 1024)
		free := float64(st.Bavail*uint64(st.Bsize)) / (1024 * 1024 * 1024)
		diskUsed = diskTotal - free
	}
	return cpuLoad(), used, total, diskUsed, diskTotal
}
func memInfo() (uint64, uint64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	vals := map[string]uint64{}
	s := bufio.NewScanner(strings.NewReader(string(b)))
	for s.Scan() {
		parts := strings.Fields(s.Text())
		if len(parts) >= 2 {
			v, _ := strconv.ParseUint(parts[1], 10, 64)
			vals[strings.TrimSuffix(parts[0], ":")] = v / 1024
		}
	}
	total := vals["MemTotal"]
	available := vals["MemAvailable"]
	return total - available, total
}
func cpuLoad() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	load, _ := strconv.ParseFloat(f[0], 64)
	cpus := float64(1)
	if n, err := os.ReadDir("/sys/devices/system/cpu"); err == nil {
		count := 0
		for _, e := range n {
			if strings.HasPrefix(e.Name(), "cpu") {
				if _, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "cpu")); err == nil {
					count++
				}
			}
		}
		if count > 0 {
			cpus = float64(count)
		}
	}
	pct := (load / cpus) * 100
	if pct > 100 {
		pct = 100
	}
	return pct
}
