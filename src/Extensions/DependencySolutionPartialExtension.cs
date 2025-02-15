using System;
using System.Linq;

namespace LumosProtobuf
{
    public partial class DependencySolution : IFormattable
    {
        public string ToString(string format, IFormatProvider formatProvider)
        {
            switch (format)
            {
                case "T": //Translatable
                    return Solution;

                default:
                    return ToString();
            }
        }
    }

    public partial class DependencyData
    {
        public bool NotResolved => Dependencies.Count > 0 || Children.Any(c => c.NotResolved);
    }

    public partial class DependencyObject
    {
        public string ToTreeString(Func<string, string> translator)
        {
            if (translator == null) translator = c => c;

            string s = translator(Type) + ": " + Name;
            if (Solution != null)
                s += " [" + translator(Solution.Solution) + "]";

            return s;
        }

        public void AddPossibleSolution(DependencySolution s)
        {
            this.PossibleSolutions.Add(s);
            if (this.Solution == null)
                this.Solution = s;
        }
    }
}
