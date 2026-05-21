from PIL import Image
import os

def tint_image(src, dest):
    img = Image.open(src).convert("RGBA")
    data = img.getdata()

    new_data = []
    # #ff8512 is 255, 133, 18
    target_r, target_g, target_b = 255, 133, 18

    for item in data:
        r, g, b, a = item
        brightness = (r + g + b) / 3
        
        if brightness > 240:
            alpha = 0
        else:
            alpha = int(255 - brightness)
            
        new_data.append((target_r, target_g, target_b, alpha))

    img.putdata(new_data)
    # Ensure the public directory exists
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    img.save(dest, "PNG")

src_path = r"C:\Users\User\.gemini\antigravity\brain\295929ea-b185-49f1-ad0b-3d1eaf41e163\.tempmediaStorage\media_295929ea-b185-49f1-ad0b-3d1eaf41e163_1778427475107.png"
dest_path = r"C:\Ubuntu\home\chief\bard\frontend\public\bard-logo.png"

try:
    tint_image(src_path, dest_path)
    print("Success")
except Exception as e:
    print(f"Error: {e}")
