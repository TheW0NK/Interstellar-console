package modrinth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
)

type SearchHit struct {
	ProjectID   string `json:"project_id"`
	Slug        string `json:"slug"`
	Title       string `json:"title"`
	Description string `json:"description"`
}
type searchResp struct {
	Hits []SearchHit `json:"hits"`
}
type version struct {
	Files []file `json:"files"`
}
type file struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Primary  bool   `json:"primary"`
}

func Search(q string) ([]SearchHit, error) {
	u := "https://api.modrinth.com/v2/search?facets=" + url.QueryEscape(`[["project_type:plugin"],["categories:paper"]]`) + "&query=" + url.QueryEscape(q)
	var r searchResp
	err := getJSON(u, &r)
	return r.Hits, err
}
func Install(slugOrID, pluginsDir string) (string, error) {
	u := "https://api.modrinth.com/v2/project/" + url.PathEscape(slugOrID) + "/version?loaders=[%22paper%22]"
	var vs []version
	if err := getJSON(u, &vs); err != nil {
		return "", err
	}
	if len(vs) == 0 {
		return "", fmt.Errorf("no Paper versions found for %s", slugOrID)
	}
	var f file
	for _, candidate := range vs[0].Files {
		if candidate.Primary {
			f = candidate
			break
		}
	}
	if f.URL == "" {
		f = vs[0].Files[0]
	}
	resp, err := http.Get(f.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("download failed: %s", resp.Status)
	}
	if err := os.MkdirAll(pluginsDir, 0755); err != nil {
		return "", err
	}
	out := filepath.Join(pluginsDir, filepath.Base(f.Filename))
	dst, err := os.Create(out)
	if err != nil {
		return "", err
	}
	defer dst.Close()
	_, err = io.Copy(dst, resp.Body)
	return out, err
}
func getJSON(u string, v any) error {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "InterstellarConsole/0.1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("modrinth returned %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}
