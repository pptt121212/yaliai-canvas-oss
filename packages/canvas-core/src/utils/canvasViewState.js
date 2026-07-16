export function buildCanvasAccessViewState(runtimeConfig) {
  const explicitAccess = runtimeConfig?.canvasAccess && typeof runtimeConfig.canvasAccess === 'object'
    ? runtimeConfig.canvasAccess
    : null;

  if (explicitAccess) {
    if (explicitAccess.allowed !== false) {
      return {
        showAccessAlert: false,
        accessTitle: '',
        accessMessage: '',
        accessHref: '',
        accessCta: '',
      };
    }

    return {
      showAccessAlert: true,
      accessTitle: String(explicitAccess.title || '当前环境限制运行'),
      accessMessage: String(explicitAccess.message || '当前接入环境暂未开放该画布运行能力。'),
      accessHref: String(explicitAccess.href || ''),
      accessCta: String(explicitAccess.cta || ''),
    };
  }

  const requiresMembership = Boolean(runtimeConfig?.requiresMembership);
  const isLoggedIn = Boolean(runtimeConfig?.isLoggedIn);
  const isMember = Boolean(runtimeConfig?.isMember);

  if (!requiresMembership || (isLoggedIn && isMember)) {
    return {
      showAccessAlert: false,
      accessTitle: '',
      accessMessage: '',
      accessHref: '',
      accessCta: '',
    };
  }

  if (!isLoggedIn) {
    return {
      showAccessAlert: true,
      accessTitle: '画布会员版',
      accessMessage: '请先登录会员账号，运行画布会验证会员权限。',
      accessHref: String(runtimeConfig?.loginUrl || '/login/'),
      accessCta: '去登录',
    };
  }

  return {
    showAccessAlert: true,
    accessTitle: '画布会员版',
    accessMessage: '当前账号暂未开通会员权限，运行画布会被拦截。',
    accessHref: String(runtimeConfig?.creditRedeemUrl || '/credits/'),
    accessCta: '查看积分/会员',
  };
}
