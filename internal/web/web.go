package web

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"interstellar-console/internal/audit"
	"interstellar-console/internal/config"
	filemgr "interstellar-console/internal/files"
	"interstellar-console/internal/modrinth"
	"interstellar-console/internal/server"
)

type App struct {
	Cfg      *config.Config
	Server   *server.Manager
	Audit    *audit.Logger
	Files    filemgr.Sandbox
	sessions map[string]string
	mu       sync.Mutex
}

func New(c *config.Config, sm *server.Manager, al *audit.Logger) *App {
	return &App{Cfg: c, Server: sm, Audit: al, Files: filemgr.Sandbox{Root: c.ContentRoot}, sessions: map[string]string{}}
}
func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.index)
	mux.HandleFunc("/api/login", a.login)
	mux.HandleFunc("/api/status", a.auth(a.status))
	mux.HandleFunc("/api/server/start", a.authRole(a.start, "owner", "admin"))
	mux.HandleFunc("/api/server/stop", a.authRole(a.stop, "owner", "admin"))
	mux.HandleFunc("/api/server/restart", a.authRole(a.restart, "owner", "admin"))
	mux.HandleFunc("/api/console/command", a.authRole(a.command, "owner", "admin"))
	mux.HandleFunc("/api/files", a.auth(a.files))
	mux.HandleFunc("/api/files/upload", a.authRole(a.upload, "owner", "admin"))
	mux.HandleFunc("/api/backups", a.auth(a.backups))
	mux.HandleFunc("/api/backups/create", a.authRole(a.backup, "owner", "admin"))
	mux.HandleFunc("/api/plugins/search", a.auth(a.pluginSearch))
	mux.HandleFunc("/api/plugins/install", a.authRole(a.pluginInstall, "owner", "admin"))
	mux.HandleFunc("/api/audit", a.authRole(a.auditTail, "owner", "admin"))
	mux.HandleFunc("/ws/logs", a.logsWS)
	return mux
}
func (a *App) index(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(a.Cfg.ContentRoot, a.Cfg.ConsoleHTML))
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	json.NewDecoder(r.Body).Decode(&in)
	for i, u := range a.Cfg.Users {
		if u.Username == in.Username && config.VerifyPassword(u, in.Password) {
			if u.Algorithm == "" || u.Algorithm == "sha256" {
				a.Cfg.Users[i] = config.NewUser(u.Username, u.Role, in.Password)
			}
			sid := token()
			a.mu.Lock()
			a.sessions[sid] = u.Username
			a.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: "vexium_session", Value: sid, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: time.Now().Add(12 * time.Hour)})
			a.Audit.Log(u.Username, "auth.login", ip(r), nil)
			writeJSON(w, map[string]any{"ok": true, "user": u.Username, "role": u.Role})
			return
		}
	}
	http.Error(w, "invalid credentials", 401)
}
func (a *App) auth(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := a.user(r)
		if u == "" {
			http.Error(w, "unauthorized", 401)
			return
		}
		next(w, r, u)
	}
}
func (a *App) authRole(next func(http.ResponseWriter, *http.Request, string), roles ...string) http.HandlerFunc {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[role] = true
	}
	return a.auth(func(w http.ResponseWriter, r *http.Request, u string) {
		role := a.role(u)
		if !allowed[role] {
			a.Audit.Log(u, "auth.forbidden", ip(r), map[string]string{"path": r.URL.Path, "role": role})
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r, u)
	})
}
func (a *App) user(r *http.Request) string {
	c, err := r.Cookie("vexium_session")
	if err != nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[c.Value]
}
func (a *App) role(username string) string {
	for _, u := range a.Cfg.Users {
		if u.Username == username {
			if u.Role == "" {
				return "viewer"
			}
			return u.Role
		}
	}
	return "viewer"
}
func (a *App) status(w http.ResponseWriter, r *http.Request, u string) {
	writeJSON(w, a.Server.Status())
}
func (a *App) start(w http.ResponseWriter, r *http.Request, u string) {
	err := a.Server.Start()
	a.done(w, u, "server.start", r, err, nil)
}
func (a *App) stop(w http.ResponseWriter, r *http.Request, u string) {
	err := a.Server.Stop()
	a.done(w, u, "server.stop", r, err, nil)
}
func (a *App) restart(w http.ResponseWriter, r *http.Request, u string) {
	err := a.Server.Restart()
	a.done(w, u, "server.restart", r, err, nil)
}
func (a *App) command(w http.ResponseWriter, r *http.Request, u string) {
	var in struct {
		Command string `json:"command"`
	}
	json.NewDecoder(r.Body).Decode(&in)
	cmd := strings.TrimPrefix(strings.TrimSpace(in.Command), "/")
	out, err := a.Server.Command(cmd)
	a.done(w, u, "console.command", r, err, map[string]string{"command": cmd, "response": out})
}
func (a *App) files(w http.ResponseWriter, r *http.Request, u string) {
	entries, err := a.Files.List(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeJSON(w, entries)
}
func (a *App) upload(w http.ResponseWriter, r *http.Request, u string) {
	if err := r.ParseMultipartForm(1 << 30); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	rel := r.FormValue("path")
	for _, hs := range r.MultipartForm.File {
		for _, h := range hs {
			if err := a.Files.SaveUpload(rel, h); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			a.Audit.Log(u, "file.upload", ip(r), map[string]string{"path": filepath.ToSlash(filepath.Join(rel, h.Filename))})
		}
	}
	writeJSON(w, map[string]any{"ok": true})
}
func (a *App) backups(w http.ResponseWriter, r *http.Request, u string) {
	entries, err := a.Files.ListBackups(a.Cfg.Backups.Directory)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, entries)
}
func (a *App) backup(w http.ResponseWriter, r *http.Request, u string) {
	_, _ = a.Server.Command("save-off")
	_, _ = a.Server.Command("save-all flush")
	path, err := a.Files.Backup(a.Cfg.Backups.Directory, a.Cfg.Backups.Include, a.Cfg.Backups.Exclude)
	_, _ = a.Server.Command("save-on")
	a.done(w, u, "backup.create", r, err, map[string]string{"path": path})
}
func (a *App) pluginSearch(w http.ResponseWriter, r *http.Request, u string) {
	hits, err := modrinth.Search(r.URL.Query().Get("q"))
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	writeJSON(w, hits)
}
func (a *App) pluginInstall(w http.ResponseWriter, r *http.Request, u string) {
	var in struct {
		Project string `json:"project"`
	}
	json.NewDecoder(r.Body).Decode(&in)
	path, err := modrinth.Install(in.Project, filepath.Join(a.Cfg.ContentRoot, "plugins"))
	a.done(w, u, "plugin.install", r, err, map[string]string{"project": in.Project, "path": path})
}
func (a *App) auditTail(w http.ResponseWriter, r *http.Request, u string) {
	http.ServeFile(w, r, a.Audit.Path())
}
func (a *App) done(w http.ResponseWriter, u, action string, r *http.Request, err error, details map[string]string) {
	if err != nil {
		a.Audit.Log(u, action+".failed", ip(r), map[string]string{"error": err.Error()})
		http.Error(w, err.Error(), 500)
		return
	}
	a.Audit.Log(u, action, ip(r), details)
	writeJSON(w, map[string]any{"ok": true, "details": details})
}

func (a *App) logsWS(w http.ResponseWriter, r *http.Request) {
	if a.user(r) == "" {
		http.Error(w, "unauthorized", 401)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	ch, unsub := a.Server.Subscribe()
	defer unsub()
	for {
		select {
		case <-r.Context().Done():
			return
		case line := <-ch:
			b, _ := json.Marshal(map[string]string{"line": line})
			w.Write([]byte("data: "))
			w.Write(b)
			w.Write([]byte("\n\n"))
			flusher.Flush()
		}
	}
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func token() string { b := make([]byte, 32); rand.Read(b); return hex.EncodeToString(b) }
func ip(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
