package faststart

import (
	"encoding/binary"
	"os"
)

var otherVideoTags = map[string]bool{
	"avc1": true, "avc3": true, "avc4": true, "vp08": true, "vp09": true, "av01": true,
	"mp4v": true, "h263": true, "s263": true, "encv": true, "dvh1": true, "dvhe": true,
}

var hevcContainers = map[string]bool{"moov": true, "trak": true, "mdia": true, "minf": true, "stbl": true}

type hevcScan struct {
	retag, extract, conflict bool
	hvc1Ready                bool
	sawHev1                  bool
}

func (s *hevcScan) merge(other hevcScan) {
	if other.retag {
		s.retag = true
	}
	if other.extract {
		s.extract = true
	}
	if other.hvc1Ready {
		s.hvc1Ready = true
	}
	if other.sawHev1 {
		s.sawHev1 = true
	}
}

// SafariHevcRewrite reports how an MP4 must be stream-copied so Safari can
// decode HEVC. retag is an hev1 entry whose hvcC already holds VPS, SPS and
// PPS. extract is an hev1 entry whose hvcC does not. A second video codec in
// the same file is neither: -tag:v hvc1 would relabel that stream too.
func SafariHevcRewrite(path string) (retag, extract bool) {
	s := readHevcScan(path)
	if s.conflict {
		return false, false
	}
	if s.extract {
		return false, true
	}
	return s.retag, false
}

// NeedsHvc1Retag reports an hev1 sample entry whose hvcC already holds
// VPS, SPS and PPS. Safari plays that layout only after a retag to hvc1.
func NeedsHvc1Retag(path string) bool {
	retag, _ := SafariHevcRewrite(path)
	return retag
}

// NeedsHevcExtract reports an hev1 sample entry whose hvcC does not already
// hold VPS, SPS and PPS. Those NALs are in the bitstream and have to be
// copied into hvcC before Safari will decode the file.
func NeedsHevcExtract(path string) bool {
	_, extract := SafariHevcRewrite(path)
	return extract
}

func readHevcScan(path string) hevcScan {
	f, err := os.Open(path)
	if err != nil {
		return hevcScan{}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 8 {
		return hevcScan{}
	}
	return scanHevc(f, 0, info.Size())
}

// hevcExtractVerified reports a normal faststart MP4 whose video sample
// entry is hvc1 and whose hvcC holds NAL types 32, 33 and 34.
func hevcExtractVerified(path string) bool {
	atom, err := secondAtom(path)
	if err != nil || atom != "moov" || hasTopLevelBox(path, "moof") {
		return false
	}
	s := readHevcScan(path)
	return s.hvc1Ready && !s.sawHev1 && !s.conflict
}

func hasTopLevelBox(path, want string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false
	}
	pos, end := int64(0), info.Size()
	hdr := make([]byte, 16)
	for pos+8 <= end {
		wantN := 16
		if remain := end - pos; remain < 16 {
			wantN = int(remain)
		}
		n, err := f.ReadAt(hdr[:wantN], pos)
		if err != nil || n < 8 {
			return false
		}
		size := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		header := int64(8)
		if size == 1 {
			if n < 16 {
				return false
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16]))
			header = 16
		} else if size == 0 {
			size = end - pos
		}
		if size < header || pos+size > end {
			return false
		}
		if typ == want {
			return true
		}
		pos += size
	}
	return false
}

func scanHevc(f *os.File, start, end int64) hevcScan {
	var out hevcScan
	pos := start
	hdr := make([]byte, 16)
	for pos+8 <= end {
		want := 16
		if remain := end - pos; remain < 16 {
			want = int(remain)
		}
		n, err := f.ReadAt(hdr[:want], pos)
		if err != nil || n < 8 {
			return hevcScan{}
		}
		size := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		header := int64(8)
		if size == 1 {
			if n < 16 {
				return hevcScan{}
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16]))
			header = 16
		} else if size == 0 {
			size = end - pos
		}
		if size < header || pos+size > end {
			return hevcScan{}
		}
		if typ == "stsd" {
			if size > 1024*1024 {
				return hevcScan{}
			}
			box := make([]byte, size)
			if _, err = f.ReadAt(box, pos); err != nil {
				return hevcScan{}
			}
			found := stsdHevc(box)
			if found.conflict {
				return found
			}
			out.merge(found)
		} else if hevcContainers[typ] {
			nested := scanHevc(f, pos+header, pos+size)
			if nested.conflict {
				return nested
			}
			out.merge(nested)
		}
		pos += size
	}
	return out
}

func stsdHevc(box []byte) hevcScan {
	header := 8
	if len(box) >= 4 && binary.BigEndian.Uint32(box[:4]) == 1 {
		header = 16
	}
	if len(box) < header+8 {
		return hevcScan{}
	}
	count := binary.BigEndian.Uint32(box[header+4 : header+8])
	off := header + 8
	var out hevcScan
	for i := uint32(0); i < count && off+8 <= len(box); i++ {
		es := int(binary.BigEndian.Uint32(box[off : off+4]))
		et := string(box[off+4 : off+8])
		if es < 8 || off+es > len(box) {
			break
		}
		entry := box[off : off+es]
		switch et {
		case "hev1":
			out.sawHev1 = true
			if entryHasParameterSets(entry) {
				out.retag = true
			} else {
				out.extract = true
			}
		case "hvc1":
			if entryHasParameterSets(entry) {
				out.hvc1Ready = true
			}
		default:
			if otherVideoTags[et] {
				out.conflict = true
			}
		}
		off += es
	}
	return out
}

func entryHasParameterSets(entry []byte) bool {
	off := 8 + 78
	if len(entry) < off+8 {
		return false
	}
	for off+8 <= len(entry) {
		n := int(binary.BigEndian.Uint32(entry[off : off+4]))
		typ := string(entry[off+4 : off+8])
		if n < 8 || off+n > len(entry) {
			return false
		}
		if typ == "hvcC" && hvccHasParameterSets(entry[off+8:off+n]) {
			return true
		}
		off += n
	}
	return false
}

func hvccHasParameterSets(hvcc []byte) bool {
	if len(hvcc) < 23 {
		return false
	}
	num := int(hvcc[22])
	i := 23
	types := map[byte]bool{}
	for a := 0; a < num && i+3 <= len(hvcc); a++ {
		types[hvcc[i]&0x3f] = true
		i++
		count := int(binary.BigEndian.Uint16(hvcc[i : i+2]))
		i += 2
		for k := 0; k < count && i+2 <= len(hvcc); k++ {
			nalLen := int(binary.BigEndian.Uint16(hvcc[i : i+2]))
			i += 2 + nalLen
		}
	}
	return types[32] && types[33] && types[34]
}
