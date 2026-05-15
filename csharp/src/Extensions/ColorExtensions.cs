namespace LumosProtobuf
{
    public partial class ColorData
    {

        public bool IsWhite => A == 255 && R == 255 && G == 255 && B == 255;
    }
}
