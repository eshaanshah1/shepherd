// Byte-identical to Sources/RemoteProtocol.swift HelperFrameCodec.
// [u32 BE len][1-byte type][payload]. type 0x00 = input (raw bytes);
// 0x01 = resize [u16 BE cols][u16 BE rows]; 0x02 = releaseSize (no payload).
// The helper does NOT link RemoteProtocol.swift, so it hand-rolls a matching decode here.
func decodeHelperFrames(_ buf: inout [UInt8]) -> [(isResize: Bool, isRelease: Bool, bytes: [UInt8], cols: Int, rows: Int)] {
    var out = [(Bool, Bool, [UInt8], Int, Int)]()
    while buf.count >= 4 {
        let len = (Int(buf[0]) << 24) | (Int(buf[1]) << 16) | (Int(buf[2]) << 8) | Int(buf[3])
        if len <= 0 || buf.count < 4 + len { break }
        let body = Array(buf[4..<4+len]); buf.removeFirst(4 + len)
        switch body[0] {
        case 0x00: out.append((false, false, Array(body[1...]), 0, 0))
        case 0x01 where body.count == 5:
            out.append((true, false, [], (Int(body[1]) << 8) | Int(body[2]), (Int(body[3]) << 8) | Int(body[4])))
        case 0x02 where body.count == 1: out.append((false, true, [], 0, 0))
        default: break
        }
    }
    return out.map { (isResize: $0.0, isRelease: $0.1, bytes: $0.2, cols: $0.3, rows: $0.4) }
}
