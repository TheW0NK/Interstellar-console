package rcon

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const packetAuth = 3
const packetCommand = 2

type Client struct {
	Host     string
	Port     int
	Password string
	Timeout  time.Duration
}

func (c Client) Execute(cmd string) (string, error) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", c.Host, c.Port), timeout(c.Timeout))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout(c.Timeout)))
	if err := writePacket(conn, 1, packetAuth, c.Password); err != nil {
		return "", err
	}
	id, _, _, err := readPacket(conn)
	if err != nil {
		return "", err
	}
	if id == -1 {
		return "", errors.New("rcon authentication failed")
	}
	if err := writePacket(conn, 2, packetCommand, cmd); err != nil {
		return "", err
	}
	_, _, body, err := readPacket(conn)
	return body, err
}
func timeout(d time.Duration) time.Duration {
	if d == 0 {
		return 5 * time.Second
	}
	return d
}
func writePacket(conn net.Conn, id, typ int32, body string) error {
	var buf bytes.Buffer
	size := int32(4 + 4 + len(body) + 2)
	binary.Write(&buf, binary.LittleEndian, size)
	binary.Write(&buf, binary.LittleEndian, id)
	binary.Write(&buf, binary.LittleEndian, typ)
	buf.WriteString(body)
	buf.Write([]byte{0, 0})
	_, err := conn.Write(buf.Bytes())
	return err
}
func readPacket(conn net.Conn) (int32, int32, string, error) {
	var size int32
	if err := binary.Read(conn, binary.LittleEndian, &size); err != nil {
		return 0, 0, "", err
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(conn, data); err != nil {
		return 0, 0, "", err
	}
	if len(data) < 10 {
		return 0, 0, "", errors.New("short rcon packet")
	}
	id := int32(binary.LittleEndian.Uint32(data[0:4]))
	typ := int32(binary.LittleEndian.Uint32(data[4:8]))
	body := string(data[8 : len(data)-2])
	return id, typ, body, nil
}
