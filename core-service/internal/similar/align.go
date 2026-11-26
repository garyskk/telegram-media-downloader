package similar

import (
	"context"
	"math"
	"runtime"
	"sync"
)

const (
	dirStop = 0
	dirDiag = 1
	dirUp   = 2
	dirLeft = 3
)

// Frame is one sampled perceptual hash.
type Frame struct {
	TSec  float64
	Phash string
}

// Alignment is a Smith-Waterman local alignment of two hash sequences.
type Alignment struct {
	Score         float64
	Matched       int
	AlignedPairs  int
	MeanHamming   float64
	CoverageA     float64
	CoverageB     float64
	CoverageShort float64
	StartIndexA   int
	StartIndexB   int
	OffsetASec    float64
	OffsetBSec    float64
	HasOffset     bool
	Cancelled     bool
}

type alignOpts struct {
	matchHamming  float64
	matchScore    float64
	mismatchScore float64
	gapScore      float64
}

func scoreOpts(matchHamming float64) alignOpts {
	if math.IsNaN(matchHamming) {
		matchHamming = 50
	}
	return alignOpts{matchHamming: matchHamming, matchScore: 2, mismatchScore: -1, gapScore: -1}
}

func emptyAlign() Alignment {
	return Alignment{MeanHamming: math.Inf(1), StartIndexA: -1, StartIndexB: -1}
}

// parallelAlign runs one Smith-Waterman per right-hand sequence. Results stay
// in rights order. A cancelled ctx stops scheduling further pairs and drops
// the in-flight ones once their current row notices.
func parallelAlign(ctx context.Context, left []Frame, rights [][]Frame, matchHamming float64) ([]Alignment, bool) {
	out := make([]Alignment, len(rights))
	if len(rights) == 0 {
		return out, ctx != nil && ctx.Err() != nil
	}
	workers := runtime.GOMAXPROCS(0)
	if workers > len(rights) {
		workers = len(rights)
	}
	if workers < 1 {
		workers = 1
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for i := range jobs {
				out[i] = AlignHashSequences(ctx, left, rights[i], matchHamming)
			}
		}()
	}
	cancelled := ctx != nil && ctx.Err() != nil
	for i := range rights {
		if ctx != nil && ctx.Err() != nil {
			cancelled = true
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if cancelled || (ctx != nil && ctx.Err() != nil) {
		return out, true
	}
	for i := range out {
		if out[i].Cancelled {
			return out, true
		}
	}
	return out, false
}

// AlignHashSequences runs Smith-Waterman. A match is a Hamming distance at or
// below matchHamming. ctx cancellation is checked between rows so Analyze can stop.
func AlignHashSequences(ctx context.Context, seqA, seqB []Frame, matchHamming float64) Alignment {
	if ctx != nil && ctx.Err() != nil {
		out := emptyAlign()
		out.Cancelled = true
		return out
	}
	opts := scoreOpts(matchHamming)
	a := normFrames(seqA)
	b := normFrames(seqB)
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return emptyAlign()
	}
	aBytes := make([][]byte, n)
	bBytes := make([][]byte, m)
	for i := range a {
		aBytes[i] = hexBytes(a[i].Phash)
	}
	for i := range b {
		bBytes[i] = hexBytes(b[i].Phash)
	}
	cols := m + 1
	H := make([]float64, (n+1)*cols)
	P := make([]byte, (n+1)*cols)
	best := 0.0
	bestI, bestJ := 0, 0
	for i := 1; i <= n; i++ {
		if ctx != nil && ctx.Err() != nil {
			out := emptyAlign()
			out.Cancelled = true
			return out
		}
		row := i * cols
		prev := (i - 1) * cols
		leftBytes := aBytes[i-1]
		for j := 1; j <= m; j++ {
			ham := hammingBytes(leftBytes, bBytes[j-1])
			sub := opts.mismatchScore
			if ham <= opts.matchHamming {
				sub = opts.matchScore
			}
			diag := H[prev+(j-1)] + sub
			up := H[prev+j] + opts.gapScore
			left := H[row+(j-1)] + opts.gapScore
			v := 0.0
			dir := byte(dirStop)
			if diag > v {
				v = diag
				dir = dirDiag
			}
			if up > v {
				v = up
				dir = dirUp
			}
			if left > v {
				v = left
				dir = dirLeft
			}
			if v <= 0 {
				v = 0
				dir = dirStop
			}
			H[row+j] = v
			P[row+j] = dir
			if v > best || (v == best && i+j > bestI+bestJ) {
				best = v
				bestI = i
				bestJ = j
			}
		}
	}
	if best <= 0 {
		return emptyAlign()
	}
	type pair struct {
		i, j int
		ham  float64
	}
	var pairs []pair
	i, j := bestI, bestJ
	for i > 0 && j > 0 {
		dir := P[i*cols+j]
		if dir == dirStop {
			break
		}
		if dir == dirDiag {
			pairs = append(pairs, pair{i: i - 1, j: j - 1, ham: hammingBytes(aBytes[i-1], bBytes[j-1])})
			i--
			j--
			continue
		}
		if dir == dirUp {
			i--
			continue
		}
		j--
	}
	for l, r := 0, len(pairs)-1; l < r; l, r = l+1, r-1 {
		pairs[l], pairs[r] = pairs[r], pairs[l]
	}
	if len(pairs) == 0 {
		return emptyAlign()
	}
	hamSum := 0.0
	matched := 0
	for _, p := range pairs {
		hamSum += p.ham
		if p.ham <= opts.matchHamming {
			matched++
		}
	}
	startA, startB := pairs[0].i, pairs[0].j
	shorter := n
	if m < shorter {
		shorter = m
	}
	if shorter == 0 {
		shorter = 1
	}
	return Alignment{
		Score:         best,
		Matched:       matched,
		AlignedPairs:  len(pairs),
		MeanHamming:   hamSum / float64(len(pairs)),
		CoverageA:     float64(matched) / float64(n),
		CoverageB:     float64(matched) / float64(m),
		CoverageShort: float64(matched) / float64(shorter),
		StartIndexA:   startA,
		StartIndexB:   startB,
		OffsetASec:    a[startA].TSec,
		OffsetBSec:    b[startB].TSec,
		HasOffset:     true,
	}
}

func normFrames(seq []Frame) []Frame {
	if len(seq) == 0 {
		return nil
	}
	out := make([]Frame, len(seq))
	for i, item := range seq {
		out[i] = Frame{TSec: item.TSec, Phash: item.Phash}
		if item.TSec == 0 && item.Phash != "" {
			// Zero is a real timestamp. Keep it.
			out[i].TSec = item.TSec
		}
	}
	return out
}

func hexBytes(hex string) []byte {
	if len(hex) < 2 || len(hex)%2 != 0 {
		return nil
	}
	out := make([]byte, len(hex)/2)
	for i := range out {
		hi := nibble(hex[i*2])
		lo := nibble(hex[i*2+1])
		if hi < 0 || lo < 0 {
			return nil
		}
		out[i] = byte(hi<<4 | lo)
	}
	return out
}

func nibble(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c - 'a' + 10)
	case c >= 'A' && c <= 'F':
		return int(c - 'A' + 10)
	default:
		return -1
	}
}

func hammingBytes(a, b []byte) float64 {
	if a == nil || b == nil {
		return math.Inf(1)
	}
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	d := 0
	for i := 0; i < n; i++ {
		d += bitsInByte[a[i]^b[i]]
	}
	return float64(d)
}
