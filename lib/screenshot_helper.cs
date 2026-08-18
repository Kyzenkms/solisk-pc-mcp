using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;

namespace ScreenshotHelper
{
    class Program
    {
        static void Main(string[] args)
        {
            try {
                if (args.Length == 0) {
                    Console.Error.WriteLine("Usage: screenshot_helper.exe <outputPath> [x y width height]");
                    Environment.Exit(1);
                }

                string outputPath = args[0];
                int x = -1, y = -1, width = -1, height = -1;

                if (args.Length >= 5) {
                    int.TryParse(args[1], out x);
                    int.TryParse(args[2], out y);
                    int.TryParse(args[3], out width);
                    int.TryParse(args[4], out height);
                }

                Bitmap bitmap;
                if (x >= 0 && y >= 0 && width > 0 && height > 0) {
                    bitmap = new Bitmap(width, height);
                    using (Graphics g = Graphics.FromImage(bitmap)) {
                        g.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                    }
                } else {
                    int left = int.MaxValue, top = int.MaxValue, right = int.MinValue, bottom = int.MinValue;
                    foreach (Screen s in Screen.AllScreens) {
                        if (s.Bounds.X < left) left = s.Bounds.X;
                        if (s.Bounds.Y < top) top = s.Bounds.Y;
                        if (s.Bounds.Right > right) right = s.Bounds.Right;
                        if (s.Bounds.Bottom > bottom) bottom = s.Bounds.Bottom;
                    }
                    int totalW = right - left;
                    int totalH = bottom - top;
                    bitmap = new Bitmap(totalW, totalH);
                    using (Graphics g = Graphics.FromImage(bitmap)) {
                        g.CopyFromScreen(left, top, 0, 0, bitmap.Size);
                    }
                }

                if (outputPath.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) {
                    bitmap.Save(outputPath, ImageFormat.Png);
                } else {
                    ImageCodecInfo jpgCodec = null;
                    foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {
                        if (codec.MimeType == "image/jpeg") { jpgCodec = codec; break; }
                    }
                    if (jpgCodec != null) {
                        EncoderParameters ep = new EncoderParameters(1);
                        ep.Param[0] = new EncoderParameter(Encoder.Quality, 80L);
                        bitmap.Save(outputPath, jpgCodec, ep);
                    } else {
                        bitmap.Save(outputPath, ImageFormat.Jpeg);
                    }
                }
                bitmap.Dispose();
                Console.WriteLine("SUCCESS");
            } catch (Exception ex) {
                Console.Error.WriteLine("ERROR: " + ex.Message);
                Environment.Exit(1);
            }
        }
    }
}
