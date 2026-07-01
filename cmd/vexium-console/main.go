package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"path/filepath"

	"interstellar-console/internal/audit"
	"interstellar-console/internal/config"
	"interstellar-console/internal/server"
	"interstellar-console/internal/web"
)

func main() {
	cfgPath := flag.String("config", "config.json", "path to generated configuration")
	flag.Parse()
	cfg, _, err := config.LoadOrCreate(*cfgPath)
	if err != nil {
		log.Fatal(err)
	}
	sm := server.New(cfg)
	al := audit.New(filepath.Join(cfg.ContentRoot, "audit.log"))
	app := web.New(cfg, sm, al)
	fmt.Printf("Vexium console serving http://%s\n", cfg.Addr())
	log.Fatal(http.ListenAndServe(cfg.Addr(), app.Routes()))
}
