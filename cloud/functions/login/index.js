// 云函数：微信登录
// 通过 wx.login 获取的 code 换取 openid，并将用户信息写入云数据库
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const userCollection = db.collection('users')

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()

  try {
    const { code, userInfo } = event
    const openid = wxContext.OPENID
    const unionid = wxContext.UNIONID
    const appid = wxContext.APPID

    // 生成自定义 token
    const token = generateToken(openid)

    // 将用户信息写入或更新到云数据库 users 集合
    const now = new Date()
    const existing = await userCollection.where({ openid }).get()

    if (existing.data.length > 0) {
      // 已存在则更新
      await userCollection.where({ openid }).update({
        data: {
          nickName: userInfo?.nickName || existing.data[0].nickName,
          avatarUrl: userInfo?.avatarUrl || existing.data[0].avatarUrl,
          gmt_modified: now,
          lastLoginTime: now,
        }
      })
    } else {
      // 不存在则新增
      await userCollection.add({
        data: {
          openid,
          unionid,
          nickName: userInfo?.nickName || '',
          avatarUrl: userInfo?.avatarUrl || '',
          gmt_create: now,
          gmt_modified: now,
          lastLoginTime: now,
        }
      })
    }

    console.log('[Login] 登录成功, openid:', openid)

    return {
      code: 0,
      message: '登录成功',
      data: {
        openid,
        unionid,
        appid,
        token,
        isNewUser: existing.data.length === 0
      }
    }
  } catch (err) {
    console.error('[Login] 云函数登录失败:', err)
    return {
      code: -1,
      message: '登录失败',
      error: err.message || err
    }
  }
}

function generateToken(openid) {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 10)
  return `${openid}_${timestamp}_${random}`
}