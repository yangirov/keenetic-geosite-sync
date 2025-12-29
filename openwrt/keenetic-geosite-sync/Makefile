include $(TOPDIR)/rules.mk

PKG_NAME:=keenetic-geosite-sync
PKG_VERSION:=1.0.7
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Emil Yangirov

include $(INCLUDE_DIR)/package.mk

define Package/keenetic-geosite-sync
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Sync Keenetic DNS object-groups from v2fly geosite lists
  DEPENDS:=+node
  PKGARCH:=all
endef

define Package/keenetic-geosite-sync/description
  Sync Keenetic DNS object-groups from v2fly geosite lists.
endef

define Build/Prepare
	$(Build/Prepare/Default)
	$(CP) $(CURDIR)/../../src $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../scripts $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../package.json $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../package-lock.json $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../tsconfig.json $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../tsup.config.ts $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../../config.json $(PKG_BUILD_DIR)/
endef

define Build/Compile
	cd $(PKG_BUILD_DIR); \
		npm ci && npm run build
endef

define Package/keenetic-geosite-sync/install
	$(INSTALL_DIR) $(1)/opt/keenetic-geosite-sync
	$(INSTALL_DIR) $(1)/opt/scripts
	$(INSTALL_DIR) $(1)/opt/etc/init.d
	$(INSTALL_DIR) $(1)/opt/var/log
	$(INSTALL_DIR) $(1)/opt/var/run

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/dist/index.js $(1)/opt/keenetic-geosite-sync/index.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/dist/config.json $(1)/opt/keenetic-geosite-sync/config.json
	$(CP) $(PKG_BUILD_DIR)/dist/scripts $(1)/opt/keenetic-geosite-sync/

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/scripts/geosite-sync.sh $(1)/opt/scripts/geosite-sync.sh
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/scripts/S99geosite-sync $(1)/opt/etc/init.d/S99geosite-sync
endef

define Package/keenetic-geosite-sync/conffiles
/opt/keenetic-geosite-sync/config.json
endef

$(eval $(call BuildPackage,keenetic-geosite-sync))
