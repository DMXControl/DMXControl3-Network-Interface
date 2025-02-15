using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace LumosProtobuf.I18N
{
    public static class TranslatableDataBuilder
    {

        public static TranslateableData _(string formatString, params object[] parameters)
        {
            var r = new TranslateableData()
            {
                FormatString = formatString ?? String.Empty
            };

            if (parameters == null || parameters.Length == 0) return r;

            foreach (var parameter in parameters)
            {
                ObjectData od = null;
                switch (parameter)
                {
                    case TranslateableData td:
                        r.Parameters.Add(new TranslateableData.Types.TranslateableObject() { Translateable = td });
                        break;
                    case bool b:
                        od = new ObjectData() { BoolValue = b };
                        break;
                    case sbyte sb:
                        od = new ObjectData() { IntValue = sb };
                        break;
                    case byte b:
                        od = new ObjectData() { UintValue = b };
                        break;
                    case short s:
                        od = new ObjectData() { IntValue = s };
                        break;
                    case ushort us:
                        od = new ObjectData() { UintValue = us };
                        break;
                    case int i:
                        od = new ObjectData() { IntValue = i };
                        break;
                    case long l:
                        od = new ObjectData() { LongValue = l };
                        break;
                    case float f:
                        od = new ObjectData() { FloatValue = f };
                        break;
                    case double d:
                        od = new ObjectData() { DoubleValue = d };
                        break;
                    case uint ui:
                        od = new ObjectData() { UintValue = ui };
                        break;
                    case ulong ul:
                        od = new ObjectData() { UlongValue = ul };
                        break;
                    default:
                        od = new ObjectData() { StringValue = parameter?.ToString() ?? String.Empty };
                        break;
                }

                if (od != null)
                    r.Parameters.Add(new TranslateableData.Types.TranslateableObject() { ObjectData = od });

            }

            return r;
        }
    }
}
