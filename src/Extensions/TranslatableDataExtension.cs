using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace LumosProtobuf
{
    public partial class TranslateableData
    {
        public static explicit operator string(TranslateableData input) => input?.ToFormatedString();

        public string ToFormatedString()
        {
            if (Parameters.Count == 0)
                return FormatString;

            List<object> paras = new List<object>();
            foreach (var to in Parameters)
            {
                switch (to.ValueCase)
                {
                    case Types.TranslateableObject.ValueOneofCase.None: 
                        paras.Add("");
                        break;
                    case Types.TranslateableObject.ValueOneofCase.ObjectData:
                        paras.Add(to.ObjectData.ToObjectSimple());
                        break;
                    case Types.TranslateableObject.ValueOneofCase.Translateable:
                        paras.Add(to.Translateable.ToFormatedString());
                        break;
                }
            }

            return String.Format(FormatString, paras.ToArray());
        }
        
    }

    public partial class ObjectData
    {

        public object ToObjectSimple()
        {
            switch (ValueCase)
            {
                case ValueOneofCase.BoolValue: return BoolValue;
                case ValueOneofCase.ByteValue: return ByteValue;
                case ValueOneofCase.DoubleValue: return DoubleValue;
                case ValueOneofCase.FloatValue: return FloatValue;
                case ValueOneofCase.IntValue: return IntValue;
                case ValueOneofCase.StringValue: return StringValue;
                case ValueOneofCase.LongValue: return LongValue;
                case ValueOneofCase.UintValue: return UintValue;
                case ValueOneofCase.UlongValue: return UlongValue;
                case ValueOneofCase.ShortValue: return ShortValue;
                case ValueOneofCase.SbyteValue: return SbyteValue;
                case ValueOneofCase.UshortValue: return UshortValue;
                default: return String.Empty;
            }
        }

    }
}
