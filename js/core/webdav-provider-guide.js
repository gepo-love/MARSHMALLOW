const PROVIDERS = [
  {
    id: 'koofr',
    name: 'Koofr',
    badge: '大文件',
    summary: '10 GB 免费、文件大小不限，使用邮箱和应用密码',
    url: 'https://app.koofr.net/dav/Koofr/',
    usernameLabel: '注册邮箱',
    passwordLabel: '应用密码',
    officialUrl: 'https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/',
    officialLabel: '打开 Koofr 设置说明',
  },
  {
    id: 'infinicloud',
    name: 'InfiniCLOUD',
    badge: '20 GB',
    summary: '从 My Page 复制专属连接地址、ID 和应用密码',
    url: '',
    usernameLabel: 'Connection ID',
    passwordLabel: 'Apps Password',
    officialUrl: 'https://infini-cloud.net/en/modules/mypage/usage/',
    officialLabel: '打开 InfiniCLOUD My Page',
  },
  {
    id: 'jianguoyun',
    name: '坚果云',
    badge: '国内',
    summary: '连接方便，但默认单文件上限为 500 MB',
    url: 'https://dav.jianguoyun.com/dav/',
    usernameLabel: '注册邮箱',
    passwordLabel: '第三方应用密码',
    officialUrl: 'https://help.jianguoyun.com/?p=2064',
    officialLabel: '打开坚果云设置说明',
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    badge: '自建',
    summary: '填写文件页显示的个人 WebDAV 地址和应用密码',
    url: '',
    usernameLabel: '用户名',
    passwordLabel: '应用密码',
    officialUrl: 'https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webdav.html',
    officialLabel: '打开 Nextcloud 设置说明',
  },
  {
    id: 'custom',
    name: '其他',
    badge: '',
    summary: '填写服务商提供的完整 WebDAV 目录地址',
    url: '',
    usernameLabel: '账号',
    passwordLabel: 'WebDAV 密码',
    officialUrl: '',
    officialLabel: '',
  },
];

export const WEBDAV_PROVIDER_GUIDES = Object.freeze(
  PROVIDERS.map((provider) => Object.freeze({ ...provider })),
);

export function getWebDavProviderGuide(id = '') {
  return WEBDAV_PROVIDER_GUIDES.find((provider) => provider.id === id)
    || WEBDAV_PROVIDER_GUIDES[WEBDAV_PROVIDER_GUIDES.length - 1];
}

export function inferWebDavProvider(url = '') {
  const value = String(url || '').trim().toLowerCase();
  if (value.includes('app.koofr.net/dav/')) return 'koofr';
  if (value.includes('dav.jianguoyun.com/dav')) return 'jianguoyun';
  if (value.includes('teracloud.jp/dav') || value.includes('infini-cloud.net/dav')) return 'infinicloud';
  if (value.includes('/remote.php/dav/')) return 'nextcloud';
  return 'custom';
}
