using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace LumosProtobuf
{
    //public partial class ProjectMetadata
    //{

    //    public string GetProjectVersionString()
    //    {
    //        return ProjectVersion + "." + ProjectBuild.ToString().PadLeft(2, '0');
    //    }


    //    public void updateToSave()
    //    {
    //        LastSaveDate = DateTime.Now.ToBinary();
    //        ProjectBuild++;
    //    }
    //}

    public partial class ProjectData
    {

        public ProjectVersionData FindVersion(ProjectVersionID id, bool compareGuid = true)
        {
            if (id == null) return null;
            if (compareGuid)
                return this.Versions.FirstOrDefault(c => Equals(c.Id, id));

            var vs = id.ToVersionString();
            return this.Versions.FirstOrDefault(c => Equals(c.Id.ToVersionString(), vs));
        }
    }

    public partial class ProjectVersionID : IComparable<ProjectVersionID>
    {

        public bool NoVersion => Major == 0 && Minor == 0 && Revision == 0;

        public static ProjectVersionID FromString(string guid, string version) => FromString(guid + "#" + version);

        public static ProjectVersionID FromString(string combined)
        {
            if (combined == null || !Regex.IsMatch(combined, "^([^#]+)(#[0-9]+(\\.[0-9]+(\\.[0-9]+)?)?)?$")) return null;

            var ret = new ProjectVersionID()
            {
                Guid = combined
            };
            if (combined.Contains("#"))
            {
                var v = combined.Split('#');
                ret.Guid = v[0];

                var tmp = v[1].Split('.');
                switch (tmp.Length)
                {
                    default: return null;

                    case 3: 
                        ret.Revision = Int32.Parse(tmp[2]);
                        goto case 2;
                    case 2:
                        ret.Minor = Int32.Parse(tmp[1]);
                        goto case 1;
                    case 1:
                        ret.Major = Int32.Parse(tmp[0]);
                        break;
                }

            }
            return ret;
        }

        public string ToCombinedString()
        {
            var a = this.Guid;
            var v = ToVersionString();
            if (!String.IsNullOrEmpty(v))
                a += "#" + v;
            return a;
        }

        public string ToVersionString()
        {
            if (Major > 0 || Minor > 0 || Revision > 0)
                return $"{Major}.{Minor}.{Revision}";
            return String.Empty;
        }

        public int CompareTo(ProjectVersionID other)
        {
            if (ReferenceEquals(this, other)) return 0;
            if (ReferenceEquals(null, other)) return 1;

            var ret = string.Compare(Guid, other.Guid, StringComparison.Ordinal);
            if (ret != 0) return ret;

            ret = Major.CompareTo(other.Major);
            if (ret != 0) return ret;

            ret = Minor.CompareTo(other.Minor);
            if (ret != 0) return ret;

            ret = Revision.CompareTo(other.Revision);
            return ret;
        }
    }

    public partial class ProjectTodoDescriptor
    {
        public static IEnumerable<ProjectTodoDescriptor> MergeToDos(IEnumerable<ProjectTodoDescriptor> existing, IEnumerable<ProjectTodoDescriptor> createdOrUpdated)
        {
            if (existing == null) return createdOrUpdated ?? Enumerable.Empty<ProjectTodoDescriptor>();
            if (createdOrUpdated == null) return existing; //Existing can't be null here

            var dict = existing.ToDictionary(c => c.Id);
            foreach (var n in createdOrUpdated)
            {
                dict[n.Id] = n;
            }
            return dict.Values;
        }
    }
}
