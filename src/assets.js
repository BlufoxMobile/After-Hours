// Painted title art (Higgsfield) + portrait cards rendered from the in-game 3D models.
// esbuild inlines each .webp as a data: URL, so the game stays one self-contained file.
import title from '../assets/title.webp';
import titleWide from '../assets/title_wide.webp';
import fox from '../assets/portraits/fox.webp';
import xb3 from '../assets/portraits/xb3.webp';
import xb6 from '../assets/portraits/xb6.webp';
import xb7 from '../assets/portraits/xb7.webp';
import xb8 from '../assets/portraits/xb8.webp';
import xb10 from '../assets/portraits/xb10.webp';
import pod from '../assets/portraits/pod.webp';
import iphone from '../assets/portraits/iphone.webp';
import galaxy from '../assets/portraits/galaxy.webp';
import fold from '../assets/portraits/fold.webp';
import bossGateway from '../assets/portraits/boss_gateway.webp';
import bossFlagship from '../assets/portraits/boss_flagship.webp';

export const ASSETS = {
  title, titleWide,
  portraits: { fox, xb3, xb6, xb7, xb8, xb10, pod, iphone, galaxy, fold, boss_gateway: bossGateway, boss_flagship: bossFlagship },
};
