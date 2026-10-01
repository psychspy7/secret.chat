"""Resize supplied artwork into platform icon sizes without altering its design."""
from pathlib import Path
import argparse
import shutil
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--icon', required=True)
parser.add_argument('--sound', required=True)
args = parser.parse_args()
mobile = Path(__file__).resolve().parents[1]
res = mobile / 'android/app/src/main/res'
public = mobile / 'public'
public.mkdir(parents=True, exist_ok=True)
image = Image.open(args.icon).convert('RGB')
image.resize((256, 256), Image.Resampling.LANCZOS).save(public / 'secretchat-icon.jpg', quality=88, optimize=True)
for density, size, adaptive in [('mdpi',48,108),('hdpi',72,162),('xhdpi',96,216),('xxhdpi',144,324),('xxxhdpi',192,432)]:
    target = res / f'mipmap-{density}'
    target.mkdir(parents=True, exist_ok=True)
    icon = image.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(target / 'ic_launcher.png')
    icon.save(target / 'ic_launcher_round.png')
    foreground = Image.new('RGBA',(adaptive,adaptive),(8,13,31,255))
    # The complete supplied logo fits within the adaptive icon's safe zone.
    safe = round(adaptive * 0.62)
    foreground.paste(image.resize((safe,safe),Image.Resampling.LANCZOS),((adaptive-safe)//2,(adaptive-safe)//2))
    foreground.save(target / 'ic_launcher_foreground.png')
raw = res / 'raw'
raw.mkdir(parents=True, exist_ok=True)
shutil.copyfile(args.sound, raw / 'secretchat_ping_v15.mp3')
shutil.copyfile(args.sound, public / 'notification.mp3')
print('SecretChat supplied icon and notification sound imported.')
