package similar

import (
	"math"
	"math/big"
	"strings"
)

const (
	pdqN     = 64
	pdqHashN = 16
)

type dctTables struct {
	cos   []float64
	alpha []float64
}

var dct64 = buildDCT(pdqN)

func buildDCT(n int) dctTables {
	cos := make([]float64, n*n)
	alpha := make([]float64, n)
	factor := math.Pi / (2 * float64(n))
	for k := 0; k < n; k++ {
		if k == 0 {
			alpha[k] = math.Sqrt2 / 2
		} else {
			alpha[k] = 1
		}
		for i := 0; i < n; i++ {
			cos[k*n+i] = math.Cos(factor * float64(2*i+1) * float64(k))
		}
	}
	return dctTables{cos: cos, alpha: alpha}
}

func dct2d(gray []float64, n int) []float64 {
	t := dct64
	if n != pdqN {
		t = buildDCT(n)
	}
	scale := 2 / float64(n)
	tmp := make([]float64, n*n)
	out := make([]float64, n*n)
	for y := 0; y < n; y++ {
		for k := 0; k < n; k++ {
			sum := 0.0
			for x := 0; x < n; x++ {
				sum += gray[y*n+x] * t.cos[k*n+x]
			}
			tmp[y*n+k] = t.alpha[k] * sum
		}
	}
	for x := 0; x < n; x++ {
		for k := 0; k < n; k++ {
			sum := 0.0
			for y := 0; y < n; y++ {
				sum += tmp[y*n+x] * t.cos[k*n+y]
			}
			out[k*n+x] = scale * t.alpha[k] * sum
		}
	}
	return out
}

func rgb24ToGray(buf []byte, px int) []float64 {
	n := px * px
	gray := make([]float64, n)
	for i := 0; i < n; i++ {
		o := i * 3
		var r, g, b byte
		if o+2 < len(buf) {
			r, g, b = buf[o], buf[o+1], buf[o+2]
		}
		gray[i] = float64(r)*0.299 + float64(g)*0.587 + float64(b)*0.114
	}
	return gray
}

func resampleNearest(gray []float64, src, dst int) []float64 {
	if src == dst {
		return gray
	}
	out := make([]float64, dst*dst)
	scale := float64(src) / float64(dst)
	for y := 0; y < dst; y++ {
		sy := int(math.Floor((float64(y) + 0.5) * scale))
		if sy > src-1 {
			sy = src - 1
		}
		for x := 0; x < dst; x++ {
			sx := int(math.Floor((float64(x) + 0.5) * scale))
			if sx > src-1 {
				sx = src - 1
			}
			out[y*dst+x] = gray[sy*src+sx]
		}
	}
	return out
}

// PDQHex is the 256-bit PDQ hash of a packed RGB24 tile, as 64 lowercase hex
// characters. Tiles that are not 64×64 are nearest-neighbour resampled.
// Frequencies 1..16 are kept (DC skipped) and bits are set against the median.
func PDQHex(buf []byte, px int) string {
	if px < 1 {
		px = pdqN
	}
	gray := resampleNearest(rgb24ToGray(buf, px), px, pdqN)
	dct := dct2d(gray, pdqN)
	block := make([]float64, pdqHashN*pdqHashN)
	for y := 0; y < pdqHashN; y++ {
		for x := 0; x < pdqHashN; x++ {
			block[y*pdqHashN+x] = dct[(y+1)*pdqN+(x+1)]
		}
	}
	sorted := append([]float64(nil), block...)
	sortFloats(sorted)
	median := (sorted[127] + sorted[128]) / 2
	bits := new(big.Int)
	for i := 0; i < 256; i++ {
		if block[i] > median {
			bits.SetBit(bits, 255-i, 1)
		}
	}
	return padHex(bits, 64)
}

func sortFloats(v []float64) {
	// Insertion sort keeps the median stable and matches a simple numeric sort
	// for 256 values without pulling in sort's NaN rules.
	for i := 1; i < len(v); i++ {
		x := v[i]
		j := i
		for j > 0 && v[j-1] > x {
			v[j] = v[j-1]
			j--
		}
		v[j] = x
	}
}

// HammingHex is the bit distance of two hex hashes. Invalid input returns -1.
func HammingHex(a, b string) int {
	xa, okA := new(big.Int).SetString(a, 16)
	xb, okB := new(big.Int).SetString(b, 16)
	if !okA || !okB || a == "" || b == "" {
		return -1
	}
	x := new(big.Int).Xor(xa, xb)
	return bitCount(x)
}

func bitCount(n *big.Int) int {
	bytes := n.Bytes()
	c := 0
	for _, b := range bytes {
		c += bitsInByte[b]
	}
	return c
}

var bitsInByte = func() [256]int {
	var t [256]int
	for i := 1; i < 256; i++ {
		t[i] = t[i>>1] + (i & 1)
	}
	return t
}()

// XORAggregate folds frame hashes into one hex string padded to the widest input.
func XORAggregate(hexes []string) string {
	acc := new(big.Int)
	width := 16
	for _, h := range hexes {
		if h == "" {
			continue
		}
		if len(h) > width {
			width = len(h)
		}
		n, ok := new(big.Int).SetString(h, 16)
		if !ok {
			continue
		}
		acc.Xor(acc, n)
	}
	return padHex(acc, width)
}

func padHex(n *big.Int, width int) string {
	s := n.Text(16)
	if len(s) < width {
		s = strings.Repeat("0", width-len(s)) + s
	}
	return s
}
