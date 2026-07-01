package files

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Sandbox struct{ Root string }
type Entry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Type     string    `json:"type"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func (s Sandbox) Resolve(rel string) (string, error) {
	if rel == "" {
		rel = "."
	}
	clean := filepath.Clean("/" + rel)[1:]
	abs := filepath.Join(s.Root, clean)
	real, err := filepath.Abs(abs)
	if err != nil {
		return "", err
	}
	root, _ := filepath.Abs(s.Root)
	if real != root && !strings.HasPrefix(real, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes content root")
	}
	return real, nil
}
func (s Sandbox) List(rel string) ([]Entry, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	ds, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	for _, d := range ds {
		info, _ := d.Info()
		typ := "file"
		if d.IsDir() {
			typ = "dir"
		}
		out = append(out, Entry{Name: d.Name(), Path: filepath.ToSlash(filepath.Join(rel, d.Name())), Type: typ, Size: info.Size(), Modified: info.ModTime()})
	}
	return out, nil
}
func (s Sandbox) SaveUpload(rel string, fh *multipart.FileHeader) error {
	dir, err := s.Resolve(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	dstPath, err := s.Resolve(filepath.Join(rel, filepath.Base(fh.Filename)))
	if err != nil {
		return err
	}
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}
func (s Sandbox) Backup(destRel string, includes, excludes []string) (string, error) {
	destDir, err := s.Resolve(destRel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return "", err
	}
	name := "backup-" + time.Now().UTC().Format("20060102-150405") + ".tar.gz"
	outPath := filepath.Join(destDir, name)
	f, err := os.Create(outPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	excluded := func(rel string) bool {
		for _, ex := range excludes {
			if ex != "" && (rel == ex || strings.HasPrefix(rel, strings.TrimSuffix(ex, "/")+"/")) {
				return true
			}
		}
		return false
	}
	for _, inc := range includes {
		root, err := s.Resolve(inc)
		if err != nil || !exists(root) {
			continue
		}
		filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil
			}
			rel, _ := filepath.Rel(s.Root, path)
			rel = filepath.ToSlash(rel)
			if excluded(rel) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			hdr, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return nil
			}
			hdr.Name = rel
			if err := tw.WriteHeader(hdr); err != nil {
				return nil
			}
			if info.Mode().IsRegular() {
				in, err := os.Open(path)
				if err == nil {
					defer in.Close()
					_, _ = io.Copy(tw, in)
				}
			}
			return nil
		})
	}
	return outPath, nil
}
func exists(p string) bool { _, err := os.Stat(p); return err == nil }
