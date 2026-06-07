package main

import (
	"fmt"
	"os"
)

type Server struct {
	host string
	port int
}

func NewServer(host string, port int) *Server {
	return &Server{host: host, port: port}
}

func (s *Server) Start() error {
	fmt.Printf("Starting on %s:%d\n", s.host, s.port)
	return nil
}

func main() {
	srv := NewServer("localhost", 8080)
	if err := srv.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
