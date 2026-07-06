package staticweb

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	root string
}

func New(root string) Handler {
	return Handler{root: root}
}

func (h Handler) Serve(c *gin.Context) {
	path := c.Request.URL.Path
	if strings.HasPrefix(path, "/api/") {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if path == "/" || path == "" {
		h.serveIndex(c)
		return
	}
	cleaned := filepath.Clean(strings.TrimPrefix(path, "/"))
	if strings.HasPrefix(cleaned, "..") || filepath.IsAbs(cleaned) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	target := filepath.Join(h.root, cleaned)
	if stat, err := os.Stat(target); err == nil && !stat.IsDir() {
		c.File(target)
		return
	}
	h.serveIndex(c)
}

func (h Handler) serveIndex(c *gin.Context) {
	indexPath := filepath.Join(h.root, "index.html")
	if stat, err := os.Stat(indexPath); err == nil && !stat.IsDir() {
		c.File(indexPath)
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(`<!doctype html><html><head><title>Patrick-IM</title></head><body><div id="root"></div></body></html>`))
}
