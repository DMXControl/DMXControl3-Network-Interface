using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Google.Protobuf;

namespace LumosProtobuf
{
    public static class ProtobufTools
    {

        public static ByteString ToByteString(this MemoryStream ms, bool defensiveCopy)
        { 
            if (defensiveCopy || !ms.TryGetBuffer(out var segment))
            {
                var a = ms.ToArray();
                return UnsafeByteOperations.UnsafeWrap(a);
            }
            else
            {
                return UnsafeByteOperations.UnsafeWrap(segment);
            }
        }

        public static ByteString ToByteString(this ReadOnlyMemory<byte> data) => UnsafeByteOperations.UnsafeWrap(data);

        public static bool ContainsNonAsciiCharacters(this string value, bool alsoCheckNonPrintable = false)
        {
            return Regex.IsMatch(value, alsoCheckNonPrintable ? @"[^\u0020-\u007E]+" : @"[^\u0000-\u007F]+");
        }
    }
}
