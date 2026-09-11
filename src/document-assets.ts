import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AppError } from './errors.js';

export const DOCUMENT_ASSET_VERSION = '6.3.289';
export const DOCUMENT_ASSET_CHUNK_BYTES = 262144;
export const DOCUMENT_ASSET_FILE_MAX_BYTES = 4194304;
export const DOCUMENT_ASSET_CACHE_MAX_BYTES = 8388608;
export type DocumentAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';
export interface DocumentAssetInput { kind: DocumentAssetKind; filename: string; offset: number }
interface Asset { kind: DocumentAssetKind; filename: string; size_bytes: number; sha256: string }

/** Exact binary inventory from pinned pdfjs-dist 6.3.289; paths, URLs and JS are never inputs. */
const pinnedAssets: readonly Asset[] = [
  {"kind":"cMapUrl","filename":"78-EUC-H.bcmap","size_bytes":2404,"sha256":"d92a261336dc18b8c03a46eb4d462382d33f4338fa195d303256b2031434c874"},
  {"kind":"cMapUrl","filename":"78-EUC-V.bcmap","size_bytes":173,"sha256":"61670bebc4e4827b67230c054fd0d820d6e30c3584d02e386804e62bbedc032a"},
  {"kind":"cMapUrl","filename":"78-H.bcmap","size_bytes":2379,"sha256":"ece6415b853d61e1b2560165151407d35cf16e6556932b85a13ea75276b77402"},
  {"kind":"cMapUrl","filename":"78-RKSJ-H.bcmap","size_bytes":2398,"sha256":"696b1f973c97623496703809eaaa5f9b40696c77540057413f4b826a08edfa7b"},
  {"kind":"cMapUrl","filename":"78-RKSJ-V.bcmap","size_bytes":173,"sha256":"53cb6d560ab377da48cf65d6dcacb0bdb31f13fab7066c580de38c12a73a7ff9"},
  {"kind":"cMapUrl","filename":"78-V.bcmap","size_bytes":169,"sha256":"289000f02fd34872b6975503217f33abae6bee676e7d28f640473a67c8db1712"},
  {"kind":"cMapUrl","filename":"78ms-RKSJ-H.bcmap","size_bytes":2651,"sha256":"a2442595218f5f8bd8e1b42188e368587d876cfe0cc4cd87196f077c878f72e2"},
  {"kind":"cMapUrl","filename":"78ms-RKSJ-V.bcmap","size_bytes":290,"sha256":"f8ddceba96bfd9d3740bd1789ee30d1f47c78371520a8084f71f7df58f19be0b"},
  {"kind":"cMapUrl","filename":"83pv-RKSJ-H.bcmap","size_bytes":905,"sha256":"44040051ec818fe09b9703472bea72efd2759d5eeb5ff0d77c718d6bb5e6d1df"},
  {"kind":"cMapUrl","filename":"90ms-RKSJ-H.bcmap","size_bytes":721,"sha256":"c13e043e85ff715b75bb03801e8fd0fb8f3a75e4a48496faa6baaf92b5b48ba1"},
  {"kind":"cMapUrl","filename":"90ms-RKSJ-V.bcmap","size_bytes":290,"sha256":"499bb916ce1adbe4289b6e5811f4dc20eb238cdc2ffad20cf26ae56716885bab"},
  {"kind":"cMapUrl","filename":"90msp-RKSJ-H.bcmap","size_bytes":715,"sha256":"7b8b3b8bbf821702e9a4df9f3596ce292380c8c1b0925dedadbb4e4b2d80498b"},
  {"kind":"cMapUrl","filename":"90msp-RKSJ-V.bcmap","size_bytes":291,"sha256":"6296c2b5c07dca8128e96d5296d621a3268803d4fa0e5812a21e52fe2802aacb"},
  {"kind":"cMapUrl","filename":"90pv-RKSJ-H.bcmap","size_bytes":982,"sha256":"fb5103f03d3a34547e18d316e52b6d9b26e485c662999222f84d2ba54c2e4fa8"},
  {"kind":"cMapUrl","filename":"90pv-RKSJ-V.bcmap","size_bytes":260,"sha256":"7bcb5ad2ba55b9662ce379e16c2d9cc2b82d621a579807353741172e4af615c2"},
  {"kind":"cMapUrl","filename":"Add-H.bcmap","size_bytes":2419,"sha256":"a2ffab28b990998181bcca9b0e914bb2207820f100ae31d5c469444892e5ad8e"},
  {"kind":"cMapUrl","filename":"Add-RKSJ-H.bcmap","size_bytes":2413,"sha256":"b29f4b52e2465d0485856d5e69f1ba69927deb2848d8fd328c8035583b35bb7e"},
  {"kind":"cMapUrl","filename":"Add-RKSJ-V.bcmap","size_bytes":287,"sha256":"2aa2232c283a3f5d0997c2834a36cead0b79ce2657944cfeed08140c293460ff"},
  {"kind":"cMapUrl","filename":"Add-V.bcmap","size_bytes":282,"sha256":"25125d3b1be64e86b2df5b3344170b45a42bcaa0b46e43a34314ef73c166e542"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-0.bcmap","size_bytes":317,"sha256":"8c65be9d51a9f269a547dc12460707aaf4031ab67ebe8a2900f4b4cc6b3e450e"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-1.bcmap","size_bytes":371,"sha256":"73152bc1a59cc594b414ac6068be48e5512b96ae85920c40e32a99269fdb0c04"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-2.bcmap","size_bytes":376,"sha256":"a1b8d353bdef9584c820464e8f1c9e2013d64ebf433cba0aa831dddf515818c2"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-3.bcmap","size_bytes":401,"sha256":"2ffc0c75c79fafde506163d3c08c390d183251009f3fbf6ae50d1167d14b9570"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-4.bcmap","size_bytes":405,"sha256":"98a1f470c878c6b9691a4d7aef776af8ac9b55f5587c9fafa00547f3bf655716"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-5.bcmap","size_bytes":406,"sha256":"ddd6e29955eb8cb545f2ebd09c628c3bbda5023256eda1b728f743c75fb77829"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-6.bcmap","size_bytes":406,"sha256":"317bb2db71e0e5b7b0c47b75de1da915c2e22f65f0c0861507f9ca7ba238f8a2"},
  {"kind":"cMapUrl","filename":"Adobe-CNS1-UCS2.bcmap","size_bytes":41193,"sha256":"e665837f2197c6bd08cd8955ad4d6932cee2398e2e328b25b00e6bfb3bd72af9"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-0.bcmap","size_bytes":217,"sha256":"8b81cce8a11d510e505704953cfa4e4ab080c1a0cab991145a3512ee433946b9"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-1.bcmap","size_bytes":250,"sha256":"0426983081788ec7202703e71f1efa4b860f75b936994236010b39d89251a81e"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-2.bcmap","size_bytes":465,"sha256":"e67b37a83b160ab3831306a71a605893b24454ee81ac9b6123bf2d3984d268d5"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-3.bcmap","size_bytes":470,"sha256":"aa299afc3e12a28726147305f191be28c7498078c8b182ece7886ac79cd99078"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-4.bcmap","size_bytes":601,"sha256":"8fbd7d74c2ddb1350c1cecce54a73fde3f5453093d4bed445283ec0033d2097f"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-5.bcmap","size_bytes":625,"sha256":"c22cb2fcff24112fa31dab2111bdc51957006576d31aad5a25e67793ac01428c"},
  {"kind":"cMapUrl","filename":"Adobe-GB1-UCS2.bcmap","size_bytes":33974,"sha256":"20507620260c0c935c35afc1e70e5888aa7125d5ec7ffc03cef1959feb2c1641"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-0.bcmap","size_bytes":225,"sha256":"464f08905236f5703b1f5cf8358767c8b18e6bcc808840d081f1de2c7ab38134"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-1.bcmap","size_bytes":226,"sha256":"4c823848722187d1ffe75ae3f5f9126ccd2d7895a05fad14c919fb119e037008"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-2.bcmap","size_bytes":233,"sha256":"7810fb808e367e70429e90a9478fe6a3fdc3e214f25c7582ce9c2da6a242315c"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-3.bcmap","size_bytes":242,"sha256":"84deb1828711ad3d390c9899c38abce1bf619d65ff7bf1a326ec95acc45f08f8"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-4.bcmap","size_bytes":337,"sha256":"3f8a4f974919c2b8bae5d10175ffa2673be140481e00840542c85d48ef184067"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-5.bcmap","size_bytes":430,"sha256":"1d3ce4ff28d977f8cf37a912ae4ec811f4175c3167b1ec0b2567feec3e79e1db"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-6.bcmap","size_bytes":485,"sha256":"5609797b9401b30be72ef9645da62a87829f058c3be4b5c623383119f584b1d9"},
  {"kind":"cMapUrl","filename":"Adobe-Japan1-UCS2.bcmap","size_bytes":40951,"sha256":"66c5d0dc4964f4093e77b194023f3a0f689324028ec8330e1e1d0570bcba7c2f"},
  {"kind":"cMapUrl","filename":"Adobe-Korea1-0.bcmap","size_bytes":241,"sha256":"dfb8c3874f0e5a8c3acf597d2c12d2b63e90bc5e4f0fce990ec4c56077d80b32"},
  {"kind":"cMapUrl","filename":"Adobe-Korea1-1.bcmap","size_bytes":386,"sha256":"62f277b7b1c441c007797ae707d5c37258d029ce4661a2b911e2e1ee35e6adc1"},
  {"kind":"cMapUrl","filename":"Adobe-Korea1-2.bcmap","size_bytes":391,"sha256":"1d77068af462f96d7ad28ad7e7d43eef6423c685b479d7dc25ff5df38db0380d"},
  {"kind":"cMapUrl","filename":"Adobe-Korea1-UCS2.bcmap","size_bytes":23293,"sha256":"857b723088be97255053562bfa41bd1075a7f7910d3bab59a0645c8bbc7060ff"},
  {"kind":"cMapUrl","filename":"B5-H.bcmap","size_bytes":1086,"sha256":"718ad0ffbef4c34f8f3f31292c462e519cd567a5511fc8b346c60010d64f4ef9"},
  {"kind":"cMapUrl","filename":"B5-V.bcmap","size_bytes":142,"sha256":"b5c37383517477620ced927b6b4ffd4f4cc6230d8051b5b46a21d6768e07f7d8"},
  {"kind":"cMapUrl","filename":"B5pc-H.bcmap","size_bytes":1099,"sha256":"bab6028aead1d6149400e904ab10cfd319082d826473ed4c582c8eeed920f17e"},
  {"kind":"cMapUrl","filename":"B5pc-V.bcmap","size_bytes":144,"sha256":"41543142b9767f3b76133899fc8453282b01ad3c653acaeea42d78c5a7d08c63"},
  {"kind":"cMapUrl","filename":"CNS-EUC-H.bcmap","size_bytes":1780,"sha256":"e8f89cd61e6486b948205da46499d659ed0aed949b7095fd3c8e95ffe2b0e7a9"},
  {"kind":"cMapUrl","filename":"CNS-EUC-V.bcmap","size_bytes":1920,"sha256":"cae422bec2ac6dbe86bf921cec942bacd2d0b733ffcca5f91b3ba14e917025a0"},
  {"kind":"cMapUrl","filename":"CNS1-H.bcmap","size_bytes":706,"sha256":"e8487971ab20cd16f3de3e8ac56ec994b72b658ad113f2818239dfd5108f501a"},
  {"kind":"cMapUrl","filename":"CNS1-V.bcmap","size_bytes":143,"sha256":"42df8076aaa7574505e7304af83a3323ec032c4177d64b1309db8c043d594a8a"},
  {"kind":"cMapUrl","filename":"CNS2-H.bcmap","size_bytes":504,"sha256":"bc6024d274d440f0625c69e25f37036ef6cb6689432ceaa160d3432a2a716ca7"},
  {"kind":"cMapUrl","filename":"CNS2-V.bcmap","size_bytes":93,"sha256":"2e4f70a8afd23a121030fc2e5b5f3816e903b11e7ba8b8c09654b31c80399c38"},
  {"kind":"cMapUrl","filename":"ETen-B5-H.bcmap","size_bytes":1125,"sha256":"87ee6b3f5bfda5fe26fa35431264c7d73070d10dbbf398a75185d63ae322c18d"},
  {"kind":"cMapUrl","filename":"ETen-B5-V.bcmap","size_bytes":158,"sha256":"47dc0d2c21e3bde317947aec1675ceabc1d5460a60bf9c24334b8c407a17172c"},
  {"kind":"cMapUrl","filename":"ETenms-B5-H.bcmap","size_bytes":101,"sha256":"d5f5a73da4173b7da9a3a20e16f26f9cd5d12deb1553409919e0cec6fd37fdee"},
  {"kind":"cMapUrl","filename":"ETenms-B5-V.bcmap","size_bytes":172,"sha256":"18252fca90f472f479af1bddd60d6ab51c8e1b55dcf6845951426504934543e0"},
  {"kind":"cMapUrl","filename":"ETHK-B5-H.bcmap","size_bytes":4426,"sha256":"d2f10fa519336bc4efcc7b6deb9604b75429946b40d82e311cb3a97a1994c89a"},
  {"kind":"cMapUrl","filename":"ETHK-B5-V.bcmap","size_bytes":158,"sha256":"1fea3fd0d9f0f679f80505800851ef2e4131d81127e18c006938ffa2f4c8b247"},
  {"kind":"cMapUrl","filename":"EUC-H.bcmap","size_bytes":578,"sha256":"f9939cd57fccdc65c5d9f4c205fd497ebdbd283643308da5663801a8c1d9c595"},
  {"kind":"cMapUrl","filename":"EUC-V.bcmap","size_bytes":170,"sha256":"1283a50a706507c4436da83ede9ad7a4440be25378f2e96f6c81a430081426a3"},
  {"kind":"cMapUrl","filename":"Ext-H.bcmap","size_bytes":2536,"sha256":"4000ed4e61a1c668ef453bbd0603cfa383defa793abd46a57ed870d7f527350b"},
  {"kind":"cMapUrl","filename":"Ext-RKSJ-H.bcmap","size_bytes":2542,"sha256":"e0d2f0df337660e73813238dd4a725f11f0621b90f3273857db253d0e7694caa"},
  {"kind":"cMapUrl","filename":"Ext-RKSJ-V.bcmap","size_bytes":218,"sha256":"f617a22b6d67febb187990952006c91a9f5a4db21155d268c656252d0c21985d"},
  {"kind":"cMapUrl","filename":"Ext-V.bcmap","size_bytes":215,"sha256":"c2087fb845a9e3acea0c2922cd40e6af67e11957bec74dcd597f1285edd490ce"},
  {"kind":"cMapUrl","filename":"GB-EUC-H.bcmap","size_bytes":549,"sha256":"928bad06fd84a48f5ba7150d7716609119fb660f2aaa73eccad81ddab9b9d203"},
  {"kind":"cMapUrl","filename":"GB-EUC-V.bcmap","size_bytes":179,"sha256":"a9ad88ac2479da529b16dc48abc5952332e27bc355335f91df5729a587533324"},
  {"kind":"cMapUrl","filename":"GB-H.bcmap","size_bytes":528,"sha256":"1018c777a8910b5bb46d7d54a4aee9d51ca5cff8addb2b41c969d9101cb3fd1c"},
  {"kind":"cMapUrl","filename":"GB-V.bcmap","size_bytes":175,"sha256":"0b96789143c0bbf9f1641ae7165b3456dccd14dabffcbb0bd654d5bf6f94f863"},
  {"kind":"cMapUrl","filename":"GBK-EUC-H.bcmap","size_bytes":14692,"sha256":"2103fed28650ede096a2281104a1a8a4304dae0db414342c636867522307123b"},
  {"kind":"cMapUrl","filename":"GBK-EUC-V.bcmap","size_bytes":180,"sha256":"a7fd35dd14d9dbdb955f34e6c0630618b6620dfd09d4283b2f65a65ce77fcaea"},
  {"kind":"cMapUrl","filename":"GBK2K-H.bcmap","size_bytes":19662,"sha256":"3d919ae72af16c5cc6846ec87a4326a9f125e493c59d3628429d35c2c95fe8c4"},
  {"kind":"cMapUrl","filename":"GBK2K-V.bcmap","size_bytes":219,"sha256":"b927fdfd595c07ce9158bf2ec13f4641b2e83b01c70989dadfabd6ed7c6ac2dc"},
  {"kind":"cMapUrl","filename":"GBKp-EUC-H.bcmap","size_bytes":14686,"sha256":"d15ebd8e81fb4fe8a244f1b1e877922e03500ac69eddf5001093e502430451d2"},
  {"kind":"cMapUrl","filename":"GBKp-EUC-V.bcmap","size_bytes":181,"sha256":"fdc736d46e642625dccc8ad8c59f2c69fc7db7a13f2e799c6c6b779e707bb97a"},
  {"kind":"cMapUrl","filename":"GBpc-EUC-H.bcmap","size_bytes":557,"sha256":"3c4a4eb82f05abe51f6650985c630e180438bfdd491318f5d20d2ec29236e1c3"},
  {"kind":"cMapUrl","filename":"GBpc-EUC-V.bcmap","size_bytes":181,"sha256":"215bdfa2842705624b4cf4cd29b8e3c720f1e192365e0305c11030a424c84d7c"},
  {"kind":"cMapUrl","filename":"GBT-EUC-H.bcmap","size_bytes":7290,"sha256":"dc5f44e48a39f3367ae28665027d8ab1d8cedb5a9dcc5068a900acd6709f60f9"},
  {"kind":"cMapUrl","filename":"GBT-EUC-V.bcmap","size_bytes":180,"sha256":"a1ad24e63653b8aa388c18fa5e498f007564e43dde699a9f91ccb4645c999be8"},
  {"kind":"cMapUrl","filename":"GBT-H.bcmap","size_bytes":7269,"sha256":"8afda745a505763f3ff54c8126eeb48ef376ea9ed07d9f42ff9a22c5c547ec57"},
  {"kind":"cMapUrl","filename":"GBT-V.bcmap","size_bytes":176,"sha256":"cdc2ec5c3c7c7033290c9a8894878202f08674eb9b1ae7d36218430326768771"},
  {"kind":"cMapUrl","filename":"GBTpc-EUC-H.bcmap","size_bytes":7298,"sha256":"7b23e2f7bfdb6c918f567b7324bf858f398bd8cd5f268d74ece19a3c91bf4f32"},
  {"kind":"cMapUrl","filename":"GBTpc-EUC-V.bcmap","size_bytes":182,"sha256":"d7a1b13ead9ab511cf2cd01de6ce8b02aa8e8767e84895337d7a3b67f039f93b"},
  {"kind":"cMapUrl","filename":"H.bcmap","size_bytes":553,"sha256":"a0233e21047ec00b852125b243cbcf30abee511155b6d8159c24f944384bc9ee"},
  {"kind":"cMapUrl","filename":"Hankaku.bcmap","size_bytes":132,"sha256":"b454701f7aecd7856769016dfd04ca64280a060f2c67a2466d50b4395d24974e"},
  {"kind":"cMapUrl","filename":"Hiragana.bcmap","size_bytes":124,"sha256":"2ed669394756dd9458651cd9995ab29ab691ecb7686659003306cdf22767a414"},
  {"kind":"cMapUrl","filename":"HKdla-B5-H.bcmap","size_bytes":2654,"sha256":"5242bce18fb13ab4cc59b146a03eba36e4ce42667eeff09e10981a9d2aa4996b"},
  {"kind":"cMapUrl","filename":"HKdla-B5-V.bcmap","size_bytes":148,"sha256":"2e0537f786c0791d41a925f72bad2d4e7268aa6cbf15a1400a722672cec38e2c"},
  {"kind":"cMapUrl","filename":"HKdlb-B5-H.bcmap","size_bytes":2414,"sha256":"fdc8159984bf5dbe475c0d5dfcb621ecee4dea07c38c668bd77f4c679e23b9b3"},
  {"kind":"cMapUrl","filename":"HKdlb-B5-V.bcmap","size_bytes":148,"sha256":"b249eb9dcb915ab45057c5d4d7aa55ef88d0efbb092af6bae0b2d4705d139abf"},
  {"kind":"cMapUrl","filename":"HKgccs-B5-H.bcmap","size_bytes":2292,"sha256":"ab64c7fc5e9b2e97750cc4f269b0da14fd8649e49151b7598c8df86599bac591"},
  {"kind":"cMapUrl","filename":"HKgccs-B5-V.bcmap","size_bytes":149,"sha256":"02ebdf7cdffb5395fb21091cd58a013a18ae5388922822f9dc6292ef16b98956"},
  {"kind":"cMapUrl","filename":"HKm314-B5-H.bcmap","size_bytes":1772,"sha256":"bfd8bbde6b36a9da4c1c902c74121a30d9807a7079a00eeea218be6adc223cef"},
  {"kind":"cMapUrl","filename":"HKm314-B5-V.bcmap","size_bytes":149,"sha256":"2a64a815cfb6fdd480674a868762e3d161fda17543b20c9209978559f0667164"},
  {"kind":"cMapUrl","filename":"HKm471-B5-H.bcmap","size_bytes":2171,"sha256":"49d7c037758826b5b6c0fa329c35bbf25d3943197754e72ecd30c6fb04d745e6"},
  {"kind":"cMapUrl","filename":"HKm471-B5-V.bcmap","size_bytes":149,"sha256":"be24c109e78aa4fe3c1f27d30aab3ed0741e783fa1b6b6c2719741072b54b132"},
  {"kind":"cMapUrl","filename":"HKscs-B5-H.bcmap","size_bytes":4437,"sha256":"08599378f41d96b40537adef6e6edcc4a787bc63f5accf47c026df4905a13914"},
  {"kind":"cMapUrl","filename":"HKscs-B5-V.bcmap","size_bytes":159,"sha256":"d073542b7dad1c4cbf01c1af5f0cd13218d1281a491956e310c55702fc8705c4"},
  {"kind":"cMapUrl","filename":"Katakana.bcmap","size_bytes":100,"sha256":"3b6ca6642fbf8822da00d5e58a8aa275216d5c32dbf2bd73e934197fc9fc5c53"},
  {"kind":"cMapUrl","filename":"KSC-EUC-H.bcmap","size_bytes":1848,"sha256":"6784e16dbc5861c036c23d3e55f0d4ba0975a3e464da0ee8e49bcfff0be070c4"},
  {"kind":"cMapUrl","filename":"KSC-EUC-V.bcmap","size_bytes":164,"sha256":"fdb36bad85e9924823d49db374067988e024cf80fc894711f2c9178951cbbe95"},
  {"kind":"cMapUrl","filename":"KSC-H.bcmap","size_bytes":1831,"sha256":"c1f6d61f1d3304fd539a65ae72624fa567ecc3853bf52e283958a7a2515b3eee"},
  {"kind":"cMapUrl","filename":"KSC-Johab-H.bcmap","size_bytes":16791,"sha256":"939993d213f68db763bf156217c217ae23af082b91a0eacecf3d11eb4ff8ef8c"},
  {"kind":"cMapUrl","filename":"KSC-Johab-V.bcmap","size_bytes":166,"sha256":"5d61967aac0e666def721e8b8d0fed8f95a879a14f2e76ce516c3d11c621e519"},
  {"kind":"cMapUrl","filename":"KSC-V.bcmap","size_bytes":160,"sha256":"d7da5afd9f1fe74816d79c9325f0139a4efb6438664ebfdf9a7aa92f3034360f"},
  {"kind":"cMapUrl","filename":"KSCms-UHC-H.bcmap","size_bytes":2787,"sha256":"5b70d8f6a4fa9e2283dc649f0ff95d906d56efbee50a20e8d2faec3a8fed078e"},
  {"kind":"cMapUrl","filename":"KSCms-UHC-HW-H.bcmap","size_bytes":2789,"sha256":"a5e6ba22aceb02fdedee11bfb9ed138463d89e85b87810b9f075b469d936f8ec"},
  {"kind":"cMapUrl","filename":"KSCms-UHC-HW-V.bcmap","size_bytes":169,"sha256":"890332a6a26880d463a12f2a6ff048bf9cf7e45077cfb1ca8815b89baa7bf411"},
  {"kind":"cMapUrl","filename":"KSCms-UHC-V.bcmap","size_bytes":166,"sha256":"1631b531c9a40c8cbe24c2317dba107362e49fa6e18af620414d627c111d570c"},
  {"kind":"cMapUrl","filename":"KSCpc-EUC-H.bcmap","size_bytes":2024,"sha256":"709480682c55cedbb0124b9960d78e28febeee0df2e34607d61aac6601647ec7"},
  {"kind":"cMapUrl","filename":"KSCpc-EUC-V.bcmap","size_bytes":166,"sha256":"031707887d6fc2378a36cdb6775334fd7a236c3f95048d8436abf43fe26fc49d"},
  {"kind":"cMapUrl","filename":"NWP-H.bcmap","size_bytes":2765,"sha256":"286c6c9e335da330928a01edc3c97a3a623f1f7f3c42762b0a7dc2f651b1a78f"},
  {"kind":"cMapUrl","filename":"NWP-V.bcmap","size_bytes":252,"sha256":"3a75fb7b59adfb172710758c425d8ac6c93fd5360a64dd4afd5dd04e60ab4b4d"},
  {"kind":"cMapUrl","filename":"RKSJ-H.bcmap","size_bytes":534,"sha256":"a70de61a22a898f693f02cc011c3e3cff2e10aaa7cddb4661e456a21ae859f78"},
  {"kind":"cMapUrl","filename":"RKSJ-V.bcmap","size_bytes":170,"sha256":"68c1a64506471a524ea5cfc3b3a9f8f70031989a6bd95427b1351f33ccf50b06"},
  {"kind":"cMapUrl","filename":"Roman.bcmap","size_bytes":96,"sha256":"1c6b3ef9d9e5cb1aa329142ce9414b90f9b6d7f9182a2a9e927378dab8f0d43f"},
  {"kind":"cMapUrl","filename":"UniCNS-UCS2-H.bcmap","size_bytes":48280,"sha256":"779428116752f34e2490a1941d24e4634c71e3c22d053b811d2090ae2fb3c704"},
  {"kind":"cMapUrl","filename":"UniCNS-UCS2-V.bcmap","size_bytes":156,"sha256":"1e5cc184b850ea44abc2df8ae5674279df668e8edf5e2a1a2ea2bd77adbd280f"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF16-H.bcmap","size_bytes":50419,"sha256":"32ff139b3c7b91d6ad25f994701f3ce7b242906022c418fd73e6493fc228bfe5"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF16-V.bcmap","size_bytes":156,"sha256":"278eb1e68d1a236c60ef59472cf0176ee0d45f364285e76ca12419a08d46fb9a"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF32-H.bcmap","size_bytes":52679,"sha256":"bf26eb67fe19ee5ba915799e80ca72408400aa8342fdf6a244a4f44de8f97336"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF32-V.bcmap","size_bytes":160,"sha256":"f7da3caf83ceb1cb37936fa10700d9ba6e9c3f72c5bc9724e3ac79bff0c0179e"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF8-H.bcmap","size_bytes":53629,"sha256":"2f2a742bcd1a84a148a4a518b9eed51a8f9c6ca5ed3bc5e2e41fff97de5dc2d8"},
  {"kind":"cMapUrl","filename":"UniCNS-UTF8-V.bcmap","size_bytes":157,"sha256":"b7c3f10780a8c62dd1c8ff6c30dc1e4e23b6cdc87c3a96fcd514cc98ffd3af9d"},
  {"kind":"cMapUrl","filename":"UniGB-UCS2-H.bcmap","size_bytes":43366,"sha256":"9201569b402e81ad8860650bd86350c4fa28e5dd5971f05fcacaf40f51de18ed"},
  {"kind":"cMapUrl","filename":"UniGB-UCS2-V.bcmap","size_bytes":193,"sha256":"f10282335e4d64203bc2a653a3a47d745ec76c8ae04549f4d50180c1899be216"},
  {"kind":"cMapUrl","filename":"UniGB-UTF16-H.bcmap","size_bytes":44086,"sha256":"386fd39581245c034da016a92d23f3df1117d169f996100050b264fc09a84e35"},
  {"kind":"cMapUrl","filename":"UniGB-UTF16-V.bcmap","size_bytes":178,"sha256":"0473cfbba612b92dd9918f0ff8aee9112897c48e0ffdc0eb82da3144ed8ea84a"},
  {"kind":"cMapUrl","filename":"UniGB-UTF32-H.bcmap","size_bytes":45738,"sha256":"f48a145dc4e3ed1dca1dde7111716a72306a2a4191ab05c6bae3a5c3a961cd2f"},
  {"kind":"cMapUrl","filename":"UniGB-UTF32-V.bcmap","size_bytes":182,"sha256":"106acc49b7118bdef944e32107b4f348238f3929a0a15d3b7aab7b9101535993"},
  {"kind":"cMapUrl","filename":"UniGB-UTF8-H.bcmap","size_bytes":46837,"sha256":"f217b439c80ee5fa1bc2cf6d1defcc319f8d84483d166a00ee199e05a68588df"},
  {"kind":"cMapUrl","filename":"UniGB-UTF8-V.bcmap","size_bytes":181,"sha256":"a64df947632878eacc532fa193c735c92a383b7d66e6f8374ac193af7c64fc63"},
  {"kind":"cMapUrl","filename":"UniJIS-UCS2-H.bcmap","size_bytes":25439,"sha256":"ad2352f40870880fbf7f8ee5abadff743fbd025fbf9830b8ada472d1c5e4da0b"},
  {"kind":"cMapUrl","filename":"UniJIS-UCS2-HW-H.bcmap","size_bytes":119,"sha256":"16e87edca954177c0881c874859d6783220925d821b5cdfb8755b61ebd93f9ce"},
  {"kind":"cMapUrl","filename":"UniJIS-UCS2-HW-V.bcmap","size_bytes":680,"sha256":"1973457e2c0192819947e56068625b34fb9a72ecc8a476ce6d7eaae5f73e2e5c"},
  {"kind":"cMapUrl","filename":"UniJIS-UCS2-V.bcmap","size_bytes":664,"sha256":"42a133d8e2ce9dd6d2288018e01592d2bf2435b326d39b94ea0b6e6a44ac33d3"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF16-H.bcmap","size_bytes":39443,"sha256":"f6a89c5688978548c83fcee990e205bc63c74274d5c69b49032a3bd4c49a05ee"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF16-V.bcmap","size_bytes":643,"sha256":"c67126fc7c73850855186bb0d6482ac0a365057e0b58778c4ab9f234683fef53"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF32-H.bcmap","size_bytes":40539,"sha256":"96195950ce0fe24443d8eb426fa6b88534ec421d7bef9046f0b2362809cfba73"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF32-V.bcmap","size_bytes":677,"sha256":"ed4dafda402bdd19c4d5d8bf2ab41473c0f86f384552b4c7b963d6627daedeb1"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF8-H.bcmap","size_bytes":41695,"sha256":"798fb0bf06ab0788d1f6a91c2db7de581612eef03c628f10e8f7ecd8f70ab448"},
  {"kind":"cMapUrl","filename":"UniJIS-UTF8-V.bcmap","size_bytes":678,"sha256":"1021611424f913b2df0bfdbe94bd327c04e224ec89d8e821c6501ea3d21f4265"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF16-H.bcmap","size_bytes":39534,"sha256":"710a32d7cb43fd6bd9dbf30da5971f8c941590f74441e208d852c2be0e74cc97"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF16-V.bcmap","size_bytes":647,"sha256":"3b149aff5c5707b57fb3215d1775852c8b1f413ec0f679ea628f25cf87fe098d"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF32-H.bcmap","size_bytes":40630,"sha256":"8d2658e18741af7937d586a57c89729a6fec0d86121197c1f8518aa58b29cdfb"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF32-V.bcmap","size_bytes":681,"sha256":"6dd475782f2897648a683c48b2fa015a15b8f06856760bddc8a17a63f418bacb"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF8-H.bcmap","size_bytes":41779,"sha256":"691c614ce432b3e62486efb54e5c84c6da5afe9b51b21253bde4758feb484183"},
  {"kind":"cMapUrl","filename":"UniJIS2004-UTF8-V.bcmap","size_bytes":682,"sha256":"40a8c7ea2d46711c5f78fc9a878a7db68b1543ba5cd60ecf14f519a2deb829b7"},
  {"kind":"cMapUrl","filename":"UniJISPro-UCS2-HW-V.bcmap","size_bytes":705,"sha256":"6826f94d789d7bf1960668c1c5819c34c9585c1b23152fbc19ee81c7df08524b"},
  {"kind":"cMapUrl","filename":"UniJISPro-UCS2-V.bcmap","size_bytes":689,"sha256":"493de9fd1a08f7946065d8ab58f0c3c9fe489f5a0f109f2d05a3169b4bd5789f"},
  {"kind":"cMapUrl","filename":"UniJISPro-UTF8-V.bcmap","size_bytes":726,"sha256":"6181d382cf736c5e09492e8be9f26f31fa25b7462253f23ab16646af432cad81"},
  {"kind":"cMapUrl","filename":"UniJISX0213-UTF32-H.bcmap","size_bytes":40517,"sha256":"692044e1fb33445668632bc9fe7386805c624864be1ddeb29d65bb0c99fc630c"},
  {"kind":"cMapUrl","filename":"UniJISX0213-UTF32-V.bcmap","size_bytes":684,"sha256":"dd54e16ca7bffb3a886242549b2bf7d78a277087f7c60d2636f118c21a5b0646"},
  {"kind":"cMapUrl","filename":"UniJISX02132004-UTF32-H.bcmap","size_bytes":40608,"sha256":"f80ea5a989be30ccda5a8804baef6d3b4b044d2b339bf8b31c671b2466171cf6"},
  {"kind":"cMapUrl","filename":"UniJISX02132004-UTF32-V.bcmap","size_bytes":688,"sha256":"94c22bd99e771c5fbe0dd8dc39850570d4db0075074aca13e272813edd7cc57f"},
  {"kind":"cMapUrl","filename":"UniKS-UCS2-H.bcmap","size_bytes":25783,"sha256":"a1081396ab4adb6f4a5b6c15f896963c244c1c9bcb65ce5616d06096a1b9811c"},
  {"kind":"cMapUrl","filename":"UniKS-UCS2-V.bcmap","size_bytes":178,"sha256":"6cab547431958fbdc1d401d06ebd4dd61a73f5509a10f974df32bcbca11a2e43"},
  {"kind":"cMapUrl","filename":"UniKS-UTF16-H.bcmap","size_bytes":26327,"sha256":"42d35b396286499dfae1737a07adb3a64500df37b426580bfb1d3ea872938519"},
  {"kind":"cMapUrl","filename":"UniKS-UTF16-V.bcmap","size_bytes":164,"sha256":"5bdb7390c80dcc136cb47d41dc7460082560969c17322ee739fe3020fb642410"},
  {"kind":"cMapUrl","filename":"UniKS-UTF32-H.bcmap","size_bytes":26451,"sha256":"3a01ec51ed1b828101351e337ffb8250abe11880032e5210f881170fed2588de"},
  {"kind":"cMapUrl","filename":"UniKS-UTF32-V.bcmap","size_bytes":168,"sha256":"dfda895eceaed081af030dbbb962b49629eea817fc3c02bae15db93d0c68acd7"},
  {"kind":"cMapUrl","filename":"UniKS-UTF8-H.bcmap","size_bytes":27790,"sha256":"3fac9c65145f72d7d42157a3b9c5ed6904632184e6a0888f2b828699afd2002f"},
  {"kind":"cMapUrl","filename":"UniKS-UTF8-V.bcmap","size_bytes":169,"sha256":"9ecc6cf30dd354b9778ddba163b6cc7302b087ce9f39d1ba73472d2b75ed13ca"},
  {"kind":"cMapUrl","filename":"V.bcmap","size_bytes":166,"sha256":"b9ad1c0c09ff14bca52f9a28a9767eb857ad0e8946e64ba14c7387a7eb69866a"},
  {"kind":"cMapUrl","filename":"WP-Symbol.bcmap","size_bytes":179,"sha256":"543923bead225732aba30976690ee89095a19628277b5863efecc2c728d5d7bf"},
  {"kind":"standardFontDataUrl","filename":"FoxitDingbats.pfb","size_bytes":29513,"sha256":"845c752392b6c914fb989c75a08b7792b88f542d2499042ef2889f8c814a16ed"},
  {"kind":"standardFontDataUrl","filename":"FoxitFixed.pfb","size_bytes":17597,"sha256":"b6c8fe53f134b8b6d4578cd2d544df4cee9624c4efa8d51a560fb40ea296101b"},
  {"kind":"standardFontDataUrl","filename":"FoxitFixedBold.pfb","size_bytes":18055,"sha256":"f1b7159702973f54fc86254ea38bcf3712b2a736eb3a0995751e9f4bb45ad603"},
  {"kind":"standardFontDataUrl","filename":"FoxitFixedBoldItalic.pfb","size_bytes":19151,"sha256":"8a000945843bd31add06aee63bf9fd41b7578b4f3242a4b7cd46349ad9d24d4d"},
  {"kind":"standardFontDataUrl","filename":"FoxitFixedItalic.pfb","size_bytes":18746,"sha256":"5007faf8320fa1fcc08b8894b356ad976f60b992ba29ee5272578bbdebaf3876"},
  {"kind":"standardFontDataUrl","filename":"FoxitSerif.pfb","size_bytes":19469,"sha256":"4f57d2b9d884af8f907bf22df6019b52d86cbf6214fdbd02b1ae05472a543f35"},
  {"kind":"standardFontDataUrl","filename":"FoxitSerifBold.pfb","size_bytes":19395,"sha256":"0bdf4b04e964139818d51eda03d566ba999fc3ba2421b1c6c51f9dc969022e80"},
  {"kind":"standardFontDataUrl","filename":"FoxitSerifBoldItalic.pfb","size_bytes":20733,"sha256":"a406cac82583bf98175cb62c87ed5e95c45fbb34eece63a10b0a13e793cb2e10"},
  {"kind":"standardFontDataUrl","filename":"FoxitSerifItalic.pfb","size_bytes":21227,"sha256":"610ae0687198045c4db5d1a6650fd5e92536631706382eb8b72e38df578d0ae9"},
  {"kind":"standardFontDataUrl","filename":"FoxitSymbol.pfb","size_bytes":16729,"sha256":"47967d055530e7357088a08403115425643ec2cdfd6201ba8af0fbd7116c1539"},
  {"kind":"standardFontDataUrl","filename":"LiberationSans-Bold.ttf","size_bytes":137052,"sha256":"361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc"},
  {"kind":"standardFontDataUrl","filename":"LiberationSans-BoldItalic.ttf","size_bytes":135124,"sha256":"a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d"},
  {"kind":"standardFontDataUrl","filename":"LiberationSans-Italic.ttf","size_bytes":162036,"sha256":"832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512"},
  {"kind":"standardFontDataUrl","filename":"LiberationSans-Regular.ttf","size_bytes":139512,"sha256":"f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f"},
  {"kind":"wasmUrl","filename":"jbig2.wasm","size_bytes":104852,"sha256":"e6bee67724a7b5436fe8162638e3708cfc8d52b6342db69a49715e30ff27cfdc"},
  {"kind":"wasmUrl","filename":"openjpeg.wasm","size_bytes":252032,"sha256":"004a0e62db930ba9ff2a22212f4554d0bb57a0635a8287caf70f98117cee14ba"},
  {"kind":"wasmUrl","filename":"qcms_bg.wasm","size_bytes":96589,"sha256":"663d86126d5f5fcb1c61490f94353e2a8375660b8c5498ab3ebab5a34b08800e"},
  {"kind":"wasmUrl","filename":"quickjs-eval.wasm","size_bytes":469105,"sha256":"7bcacc9f22cacf7e9b23866d2a6d1639693d40c7f144e41b7c69ed37ba9cbe8f"},
];
export const DOCUMENT_ASSET_INVENTORY: readonly Readonly<Asset>[] = Object.freeze(pinnedAssets.map(asset => Object.freeze({ ...asset })));
const inventory = new Map(DOCUMENT_ASSET_INVENTORY.map(asset => [asset.kind + ':' + asset.filename, asset]));
const directories: Record<DocumentAssetKind, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string) => new AppError(code, message);
const require = createRequire(import.meta.url);

function checkedBudget(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw fail('DOCUMENT_ASSET_LIMIT', 'PDF asset budgets must be bounded positive integers.');
  return limit;
}

function lookup(input: DocumentAssetInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.kind !== 'string' || !Object.hasOwn(directories, input.kind)
    || typeof input.filename !== 'string' || input.filename.length > 128
    || !/^[A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf|wasm)$/.test(input.filename)) {
    throw fail('DOCUMENT_ASSET_INVALID', 'Use an exact supported PDF asset kind and filename; paths and URLs are not accepted.');
  }
  const asset = inventory.get(input.kind + ':' + input.filename);
  if (!asset) throw fail('DOCUMENT_ASSET_INVALID', 'This exact filename is not in the pinned PDF asset inventory.');
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > asset.size_bytes) {
    throw fail('DOCUMENT_ASSET_INVALID', 'The asset offset must be an integer within the asset, including its end.');
  }
  return asset;
}

/**
 * Package-only immutable binary cache. File size/hash are pinned before any bytes
 * reach a component; bounded loads serialize so parallel cache misses cannot
 * reserve the same remaining byte budget. No document or App identity lives here.
 */
export class DocumentAssetReader {
  private readonly cache = new Map<string, Buffer>();
  private cachedBytes = 0;
  private readonly fileLimit: number;
  private readonly cacheLimit: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { maxFileBytes?: number; maxCacheBytes?: number } = {}) {
    this.fileLimit = checkedBudget(options.maxFileBytes, DOCUMENT_ASSET_FILE_MAX_BYTES);
    this.cacheLimit = checkedBudget(options.maxCacheBytes, DOCUMENT_ASSET_CACHE_MAX_BYTES);
  }

  cacheUsage() { return { entries: this.cache.size, size_bytes: this.cachedBytes, max_bytes: this.cacheLimit }; }

  async read(input: DocumentAssetInput) {
    const asset = lookup(input);
    if (asset.size_bytes > this.fileLimit || asset.size_bytes > this.cacheLimit) {
      throw fail('DOCUMENT_ASSET_LIMIT', 'This PDF asset exceeds the bounded asset cache or file budget.');
    }
    // Copy caller fields now; mutation of a queued request must not change which
    // bytes its validated request can receive.
    const offset = input.offset;
    const key = asset.kind + ':' + asset.filename;
    const task = this.queue.then(async () => {
      let bytes = this.cache.get(key);
      if (bytes) {
        this.cache.delete(key);
        this.cache.set(key, bytes);
      } else {
        while (this.cachedBytes + asset.size_bytes > this.cacheLimit) {
          const oldest = this.cache.entries().next().value;
          if (!oldest) throw fail('DOCUMENT_ASSET_LIMIT', 'The PDF asset cache cannot reserve this asset.');
          this.cache.delete(oldest[0]);
          this.cachedBytes -= oldest[1].length;
        }
        bytes = await loadPinnedAsset(asset);
        this.cache.set(key, bytes);
        this.cachedBytes += bytes.length;
      }
      const end = Math.min(bytes.length, offset + DOCUMENT_ASSET_CHUNK_BYTES);
      const chunk = bytes.subarray(offset, end), eof = end === bytes.length;
      return {
        data: { kind: asset.kind, filename: asset.filename, offset, size_bytes: chunk.length, total_bytes: bytes.length,
          next_offset: eof ? null : end, eof, sha256: asset.sha256, chunk_sha256: digest(chunk) },
        meta: { base64: chunk.toString('base64') },
      };
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}

async function loadPinnedAsset(asset: Readonly<Asset>): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const filename = path.join(packageRoot, directories[asset.kind], asset.filename);
    handle = await open(filename, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size !== asset.size_bytes || before.size > DOCUMENT_ASSET_FILE_MAX_BYTES) {
      throw fail('DOCUMENT_ASSET_UNAVAILABLE', 'The installed PDF asset does not match the pinned package inventory.');
    }
    const bytes = Buffer.alloc(asset.size_bytes);
    let read = 0;
    while (read < bytes.length) {
      const next = await handle.read(bytes, read, bytes.length - read, read);
      if (next.bytesRead === 0) throw fail('DOCUMENT_ASSET_UNAVAILABLE', 'The installed PDF asset is incomplete.');
      read += next.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || digest(bytes) !== asset.sha256) {
      throw fail('DOCUMENT_ASSET_UNAVAILABLE', 'The installed PDF asset failed its pinned integrity check.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw fail('DOCUMENT_ASSET_UNAVAILABLE', 'The pinned PDF asset is unavailable. Reinstall the locked project dependencies.');
  } finally {
    // Closing an already read package file must not leak an OS path or raw error.
    if (handle) await handle.close().catch(() => undefined);
  }
}

const sharedReader = new DocumentAssetReader();

/** Callers must authorize their document capability before AND after this await. */
export function readDocumentAsset(input: DocumentAssetInput) { return sharedReader.read(input); }
